import fsPromises from 'fs/promises';
import path from 'path';
import readline from 'readline/promises';
import crypto from 'crypto';
import type {
  AllowedLanguages,
  AudioOriginalLangAllowed,
  SegmentDetailOutWithDuration,
  SegmentWitDurationAndOriginalSegment,
} from '../types';
import { ensureDir } from '../utils/fsUtils';

interface ManualTranslationSegmentPayload {
  index: number;
  speaker: number;
  begin: number;
  end: number;
  duration: number;
  sourceLanguage: string;
  targetLanguage: AllowedLanguages;
  transcriptionToTranslate: string;
  translatedTranscription: string;
  wordsWithSilence: string;
  segmentSummary?: string;
  context: {
    previousSegment2Text: string;
    previousSegment2Speaker: string;
    previousSegment1Text: string;
    previousSegment1Speaker: string;
    nextSegment1Text: string;
    nextSegment1Speaker: string;
    nextSegment2Text: string;
    nextSegment2Speaker: string;
  };
}

interface ManualTranslationFilePayload {
  createdAt: string;
  transcriptionSummary: string;
  videoSummary: string;
  sourceLanguage: string;
  targetLanguage: AllowedLanguages;
  instructions: string;
  segments: ManualTranslationSegmentPayload[];
}

export class TextTranslator {
  static async translateTranscriptionInTargetLanguage({
    transcription,
    targetLanguage,
    originLanguage,
    transcriptionSummary,
    videoSummary,
  }: {
    transcription: SegmentDetailOutWithDuration[];
    targetLanguage: AllowedLanguages;
    originLanguage: AudioOriginalLangAllowed;
    transcriptionSummary: string;
    videoSummary?: string;
  }) {
    const translatedTranscription = await this.translateTranscription({
      transcription,
      targetLanguage,
      originLanguage,
      transcriptionSummary,
      videoSummary,
    });

    return translatedTranscription;
  }

  static async translateTranscription({
    transcription,
    targetLanguage,
    originLanguage,
    transcriptionSummary,
    videoSummary,
  }: {
    transcription: SegmentDetailOutWithDuration[];
    targetLanguage: AllowedLanguages;
    originLanguage: string;
    transcriptionSummary: string;
    videoSummary?: string;
  }) {
    console.debug('Preparing transcription for manual translation...');

    const deepCopyTranscriptions = (
      JSON.parse(JSON.stringify(transcription)) as SegmentWitDurationAndOriginalSegment[]
    ).sort((a, b) => a.index - b.index);

    const translationPayload = this.buildManualTranslationPayload({
      transcription: deepCopyTranscriptions,
      targetLanguage,
      originLanguage,
      transcriptionSummary,
      videoSummary,
    });

    const manualTranslationFilePath = await this.writeManualTranslationFile(translationPayload);
    console.info('Manual translation file created: ', manualTranslationFilePath);
    console.info('Fill `translatedTranscription` for each segment, then type "continue" and press Enter.');

    await this.waitForContinueCommand();

    const translatedTextBySegment = await this.readManualTranslations(manualTranslationFilePath);

    const translatedTranscription = deepCopyTranscriptions.map((segment) => {
      const translatedText = translatedTextBySegment.get(segment.index);
      if (!translatedText) {
        throw new Error(`Missing translated text for segment index ${segment.index}`);
      }

      return {
        ...segment,
        originalTranscription: segment.transcription,
        transcription: translatedText,
        language: targetLanguage,
      };
    });

    console.debug('Manual transcription translation loaded.');
    return translatedTranscription;
  }

  static buildManualTranslationPayload({
    transcription,
    targetLanguage,
    originLanguage,
    transcriptionSummary,
    videoSummary,
  }: {
    transcription: SegmentWitDurationAndOriginalSegment[];
    targetLanguage: AllowedLanguages;
    originLanguage: string;
    transcriptionSummary: string;
    videoSummary?: string;
  }): ManualTranslationFilePayload {
    return {
      createdAt: new Date().toISOString(),
      transcriptionSummary,
      videoSummary: videoSummary || '',
      sourceLanguage: originLanguage,
      targetLanguage,
      instructions:
        'Fill translatedTranscription for every segment. Keep `index` unchanged. Preserve timing intent and style.',
      segments: transcription.map((currentSegment, i) => {
        const previousSegment1 = i >= 1 ? transcription[i - 1] : null;
        const previousSegment2 = i >= 2 ? transcription[i - 2] : null;
        const nextSegment1 = i < transcription.length - 1 ? transcription[i + 1] : null;
        const nextSegment2 = i < transcription.length - 2 ? transcription[i + 2] : null;

        return {
          index: currentSegment.index,
          speaker: currentSegment.speaker,
          begin: currentSegment.begin,
          end: currentSegment.end,
          duration: currentSegment.duration || 0,
          sourceLanguage: originLanguage,
          targetLanguage,
          transcriptionToTranslate: currentSegment.transcription,
          translatedTranscription: '',
          wordsWithSilence: currentSegment.wordsWithSilence || '',
          segmentSummary: currentSegment.segmentSummary,
          context: {
            previousSegment2Text: previousSegment2?.transcription || '',
            previousSegment2Speaker: previousSegment2?.speaker?.toString() || '',
            previousSegment1Text: previousSegment1?.transcription || '',
            previousSegment1Speaker: previousSegment1?.speaker?.toString() || '',
            nextSegment1Text: nextSegment1?.transcription || '',
            nextSegment1Speaker: nextSegment1?.speaker?.toString() || '',
            nextSegment2Text: nextSegment2?.transcription || '',
            nextSegment2Speaker: nextSegment2?.speaker?.toString() || '',
          },
        };
      }),
    };
  }

  static async writeManualTranslationFile(payload: ManualTranslationFilePayload): Promise<string> {
    await ensureDir('temporary-files');

    const filePath = path.resolve(
      'temporary-files',
      `manual-translation-${crypto.randomUUID().slice(0, 8)}.json`,
    );

    await fsPromises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');

    return filePath;
  }

  static async waitForContinueCommand(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      while (true) {
        const userInput = (await rl.question('Type "continue" when translations are ready: '))
          .trim()
          .toLowerCase();

        if (userInput === 'continue') {
          return;
        }

        console.info('Unknown command. Please type exactly: continue');
      }
    } finally {
      rl.close();
    }
  }

  static async readManualTranslations(filePath: string): Promise<Map<number, string>> {
    const fileContent = await fsPromises.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(fileContent) as Partial<ManualTranslationFilePayload>;

    if (!Array.isArray(parsed.segments)) {
      throw new Error(`Invalid manual translation file format: ${filePath}`);
    }

    const translationsBySegment = new Map<number, string>();

    for (const segment of parsed.segments) {
      if (typeof segment.index !== 'number') {
        throw new Error('Each segment must contain a numeric index');
      }

      if (typeof segment.translatedTranscription !== 'string') {
        throw new Error(`Segment ${segment.index} must contain translatedTranscription as string`);
      }

      const translatedText = segment.translatedTranscription.trim();
      if (!translatedText) {
        throw new Error(`Segment ${segment.index} has an empty translatedTranscription`);
      }

      translationsBySegment.set(segment.index, translatedText);
    }

    return translationsBySegment;
  }
}
