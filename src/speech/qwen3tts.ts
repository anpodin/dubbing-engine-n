import { spawn } from 'child_process';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import path from 'path';
import type { AllowedLanguages } from '../types';
import { ensureDir, safeUnlink } from '../utils/fsUtils';

const qwenLanguageMap: Record<AllowedLanguages, string> = {
  swedish: 'sv',
  korean: 'ko',
  ukrainian: 'uk',
  greek: 'el',
  japanese: 'ja',
  english: 'en',
  'american english': 'en',
  russian: 'ru',
  hindi: 'hi',
  german: 'de',
  danish: 'da',
  bulgarian: 'bg',
  czech: 'cs',
  polish: 'pl',
  slovak: 'sk',
  finnish: 'fi',
  spanish: 'es',
  croatian: 'hr',
  dutch: 'nl',
  portuguese: 'pt',
  french: 'fr',
  malay: 'ms',
  italian: 'it',
  romanian: 'ro',
  mandarin: 'zh',
  tamil: 'ta',
  turkish: 'tr',
  indonesian: 'id',
  tagalog: 'tl',
  arabic: 'ar',
  estonian: 'et',
  norwegian: 'no',
  vietnamese: 'vi',
  hungarian: 'hu',
  'british english': 'en',
  'french canadian': 'fr',
};

export class Qwen3TtsService {
  static async generateAudioFile({
    text,
    targetLanguage,
    voice,
  }: {
    text: string;
    targetLanguage: AllowedLanguages;
    voice?: string;
  }): Promise<{ response: Buffer; requestId: string }> {
    await ensureDir('temporary-files');

    const requestId = crypto.randomUUID();
    const outputPath = path.resolve('temporary-files', `qwen-tts-${requestId}.wav`);
    const voiceToUse = voice || process.env.QWEN_TTS_VOICE || 'serena';
    const languageCode = qwenLanguageMap[targetLanguage] || 'en';

    try {
      await this.runTtsRouter({ text, outputPath, voice: voiceToUse, languageCode });

      const response = await fsPromises.readFile(outputPath);

      return { response, requestId };
    } finally {
      await safeUnlink(outputPath);
    }
  }

  static runTtsRouter({
    text,
    outputPath,
    voice,
    languageCode,
  }: {
    text: string;
    outputPath: string;
    voice: string;
    languageCode: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['say', text, '-o', outputPath, '--voice', voice, '--language', languageCode];
      const child = spawn('tts-router', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      let stdout = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to start tts-router: ${error.message}`));
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(
          new Error(`tts-router failed with code ${code}. stdout: ${stdout.trim()} stderr: ${stderr.trim()}`),
        );
      });
    });
  }
}
