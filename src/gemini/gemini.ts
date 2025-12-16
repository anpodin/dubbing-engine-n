import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
  type SafetySetting,
  HarmCategory,
  HarmBlockThreshold,
  type GenerateContentResponse,
} from '@google/genai';
import fsPromises from 'fs/promises';
import path from 'path';
import { geminiFileUploadThresholdMB } from '../utils/config';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const geminiModels = {
  gemini15Pro: 'gemini-1.5-pro',
  gemini15Flash: 'gemini-1.5-flash',
  gemini2Flash: 'gemini-2.0-flash',
  gemini2_5flash: 'gemini-2.5-flash',
  gemini2_5flash_lite: 'gemini-2.5-flash-lite',
} as const;

export type GeminiModel = (typeof geminiModels)[keyof typeof geminiModels];

const safetySettings: SafetySetting[] = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

const mimeTypes: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  m4v: 'video/x-m4v',
};

export class GeminiService {
  private client: GoogleGenAI;
  private apiKey: string;
  private readonly BASE_RETRY_DELAY = 5000;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not defined in environment variables');
    }
    this.client = new GoogleGenAI({ apiKey: this.apiKey });
  }

  async requestToGemini({
    prompt,
    model = geminiModels.gemini2_5flash,
    temperature = 0.7,
    filePath,
    timeoutInMs = 120000,
    _retryCount = 0,
  }: {
    prompt: string;
    model?: GeminiModel;
    temperature?: number;
    filePath?: string;
    timeoutInMs?: number;
    _retryCount?: number;
  }): Promise<string> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let geminiFileToDelete: string | undefined;

    try {
      const generationConfig = {
        temperature,
        safetySettings,
      };

      let messages: any[] = [];

      if (filePath) {
        const fileStats = await fsPromises.stat(filePath);
        const fileSizeInMB = fileStats.size / (1024 * 1024);
        const fileExtension = path.extname(filePath).toLowerCase().replace('.', '');
        const mimeType = mimeTypes[fileExtension] || 'video/mp4';

        if (fileSizeInMB > geminiFileUploadThresholdMB) {
          console.debug(`Uploading large file (${fileSizeInMB.toFixed(2)}MB) to Gemini...`);

          const uploaded = await this.client.files.upload({
            file: filePath,
            config: { mimeType },
          });

          geminiFileToDelete = uploaded.name;
          console.debug('File uploaded, waiting for processing...');

          let currentFile = uploaded;
          const uploadStartTime = Date.now();

          while (!currentFile.state || currentFile.state.toString() !== 'ACTIVE') {
            const elapsedTime = Date.now() - uploadStartTime;
            if (elapsedTime >= timeoutInMs) {
              throw new Error(`File processing timed out after ${timeoutInMs}ms`);
            }

            console.debug(`Processing video... (${Math.round(elapsedTime / 1000)}s elapsed)`);
            await sleep(5000);
            currentFile = await this.client.files.get({ name: currentFile.name! });
          }

          if (currentFile.uri && currentFile.mimeType) {
            messages = [createPartFromUri(currentFile.uri, currentFile.mimeType), prompt];
          } else {
            throw new Error('File uploaded but no URI or MIME type returned');
          }
        } else {
          const fileBuffer = await fsPromises.readFile(filePath);
          const base64Data = fileBuffer.toString('base64');

          messages = [
            {
              inlineData: {
                mimeType,
                data: base64Data,
              },
            },
            prompt,
          ];
        }
      } else {
        messages = [prompt];
      }

      const contents = createUserContent(messages);

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Request to Gemini timed out after ${timeoutInMs}ms`));
        }, timeoutInMs);
      });

      const generationPromise = this.client.models.generateContent({
        model,
        contents,
        config: generationConfig,
      });

      const result = (await Promise.race([generationPromise, timeoutPromise])) as GenerateContentResponse;

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const response = this.parseGeminiResponse(result);

      if (!response) {
        console.error('No response from Gemini:', result);
        throw new Error('No response from Gemini');
      }

      return response;
    } catch (error: any) {
      console.error('Gemini API error:', error?.message || error);

      if (_retryCount === 0 && this.isNetworkError(error)) {
        const retryDelay = this.BASE_RETRY_DELAY + Math.random() * 2000;
        console.debug(`Retrying Gemini request in ${retryDelay}ms...`);

        await sleep(retryDelay);

        return this.requestToGemini({
          prompt,
          model,
          temperature,
          filePath,
          timeoutInMs,
          _retryCount: 1,
        });
      }

      throw new Error(`Gemini API failed: ${error?.message || 'Unknown error'}`);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (geminiFileToDelete) {
        setImmediate(async () => {
          try {
            await this.client.files.delete({ name: geminiFileToDelete! });
            console.debug('Gemini file cleaned up:', geminiFileToDelete);
          } catch (deleteError) {
            console.error('Failed to delete Gemini file:', deleteError);
          }
        });
      }
    }
  }

  private parseGeminiResponse(result: GenerateContentResponse): string | null {
    const asAny = result as any;

    if (typeof asAny?.text === 'string' && asAny.text.trim().length > 0) {
      return asAny.text;
    }

    if (typeof asAny?.response?.text === 'function') {
      try {
        const textFromMethod: string = asAny.response.text();
        if (typeof textFromMethod === 'string' && textFromMethod.trim().length > 0) {
          return textFromMethod;
        }
      } catch {}
    }

    try {
      const parts: any[] | undefined =
        asAny?.candidates?.[0]?.content?.parts || asAny?.candidates?.[0]?.content?.[0]?.parts;

      if (Array.isArray(parts)) {
        const textPieces: string[] = [];
        for (const p of parts) {
          if (typeof p?.text === 'string') {
            textPieces.push(p.text);
          }
        }
        if (textPieces.length > 0) {
          return textPieces.join('');
        }
      }
    } catch {}

    return null;
  }

  private isNetworkError(error: any): boolean {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorCode = error?.code || '';

    return (
      errorCode === 'ECONNRESET' ||
      errorCode === 'ETIMEDOUT' ||
      errorCode === 'ECONNREFUSED' ||
      errorCode === 'TIMEOUT' ||
      error?.type === 'system' ||
      errorMessage.includes('timed out') ||
      errorMessage.includes('network') ||
      errorMessage.includes('connection')
    );
  }

  static isAudioOnlyFile(filePath: string): boolean {
    const audioOnlyExtensions = ['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg', 'wma', 'ac3', 'eac3'];
    const extension = path.extname(filePath).toLowerCase().replace('.', '');
    return audioOnlyExtensions.includes(extension);
  }
}
