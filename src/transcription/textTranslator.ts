import { models, requestToGPT } from '../llm/openai';
import type { OpenAIModel } from '../llm/openai';
import { PromptBuilder, defaultInstructions } from '../llm/prompt-builder';
import type {
  AllowedLanguages,
  AudioOriginalLangAllowed,
  SegmentDetailOutWithDuration,
  SegmentWitDurationAndOriginalSegment,
} from '../types';
import { textToVisemes, visemesToString } from '../utils/visemeMapper';

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
    console.debug('Translating transcription...');
    const maxSimultaneousTranslation = 10;
    let translationPromises: Promise<string>[] = [];
    const transcriptionTranslated: SegmentWitDurationAndOriginalSegment[] = [];
    const deepCopyTranscriptions = (
      JSON.parse(JSON.stringify(transcription)) as SegmentWitDurationAndOriginalSegment[]
    ).sort((a, b) => a.index - b.index) as SegmentWitDurationAndOriginalSegment[];

    try {
      for (let i = 0; i < deepCopyTranscriptions.length; i++) {
        const currentSegment = deepCopyTranscriptions[i];

        const previousSegment1 = i >= 1 ? deepCopyTranscriptions[i - 1] : null;
        const previousSegment2 = i >= 2 ? deepCopyTranscriptions[i - 2] : null;
        const nextSegment1 = i < deepCopyTranscriptions.length - 1 ? deepCopyTranscriptions[i + 1] : null;
        const nextSegment2 = i < deepCopyTranscriptions.length - 2 ? deepCopyTranscriptions[i + 2] : null;

        const translationPromise = this.getTranslationPromise({
          actualTranscription: currentSegment.transcription,
          actualTranscriptionSpeaker: currentSegment.speaker?.toString() || '0',
          wordsWithSilences: currentSegment.wordsWithSilence || '',
          segmentDuration: currentSegment.duration || 0,
          targetLanguage,
          transcriptionLanguage: originLanguage,
          transcriptionSummary,
          segmentSummary: currentSegment.segmentSummary,
          videoSummary,
          previousSegment1Text: previousSegment1?.transcription || '',
          previousSegment1Speaker: previousSegment1?.speaker?.toString() || '',
          previousSegment2Text: previousSegment2?.transcription || '',
          previousSegment2Speaker: previousSegment2?.speaker?.toString() || '',
          nextSegment1Text: nextSegment1?.transcription || '',
          nextSegment1Speaker: nextSegment1?.speaker?.toString() || '',
          nextSegment2Text: nextSegment2?.transcription || '',
          nextSegment2Speaker: nextSegment2?.speaker?.toString() || '',
        });

        translationPromises.push(translationPromise);

        if (
          translationPromises.length === maxSimultaneousTranslation ||
          i === deepCopyTranscriptions.length - 1
        ) {
          const translations: string[] = await Promise.all(translationPromises);
          for (let j = 0; j < translations.length; j++) {
            const transcriptionToUpdate = deepCopyTranscriptions[transcriptionTranslated.length];
            transcriptionToUpdate.originalTranscription = deepCopyTranscriptions[j].transcription;
            transcriptionToUpdate.transcription = translations[j];
            transcriptionToUpdate.language = targetLanguage;

            transcriptionTranslated.push(transcriptionToUpdate);
          }
          translationPromises = [];
        }
      }

      console.debug('Transcription translated.');
      return transcriptionTranslated;
    } catch (error: unknown) {
      console.error(error);
      throw new Error('Error while translating transcription');
    }
  }

  static async getTranslationPromise({
    actualTranscription,
    actualTranscriptionSpeaker,
    wordsWithSilences,
    segmentDuration,
    targetLanguage,
    transcriptionLanguage,
    transcriptionSummary,
    segmentSummary,
    videoSummary,
    previousSegment1Text,
    previousSegment1Speaker,
    previousSegment2Text,
    previousSegment2Speaker,
    nextSegment1Text,
    nextSegment1Speaker,
    nextSegment2Text,
    nextSegment2Speaker,
  }: {
    actualTranscription: string;
    actualTranscriptionSpeaker: string;
    wordsWithSilences: string;
    segmentDuration: number;
    targetLanguage: AllowedLanguages;
    transcriptionLanguage: string;
    transcriptionSummary: string;
    segmentSummary?: string;
    videoSummary?: string;
    previousSegment1Text: string;
    previousSegment1Speaker: string;
    previousSegment2Text: string;
    previousSegment2Speaker: string;
    nextSegment1Text: string;
    nextSegment1Speaker: string;
    nextSegment2Text: string;
    nextSegment2Speaker: string;
  }) {
    const maxAttempts = 3;
    let textTranslated = '';
    let attempts = 0;

    do {
      textTranslated = await this.getTranslationPromiseFromAI({
        actualTranscription,
        actualTranscriptionSpeaker,
        wordsWithSilences,
        segmentDuration,
        targetLanguage,
        transcriptionLanguage,
        transcriptionSummary,
        segmentSummary,
        videoSummary,
        previousSegment1Text,
        previousSegment1Speaker,
        previousSegment2Text,
        previousSegment2Speaker,
        nextSegment1Text,
        nextSegment1Speaker,
        nextSegment2Text,
        nextSegment2Speaker,
      });
      attempts++;
    } while (textTranslated === actualTranscription && attempts < maxAttempts);

    return textTranslated;
  }

  static async getTranslationPromiseFromAI({
    actualTranscription,
    actualTranscriptionSpeaker,
    wordsWithSilences,
    segmentDuration,
    targetLanguage,
    transcriptionLanguage,
    transcriptionSummary,
    segmentSummary,
    videoSummary,
    previousSegment1Text,
    previousSegment1Speaker,
    previousSegment2Text,
    previousSegment2Speaker,
    nextSegment1Text,
    nextSegment1Speaker,
    nextSegment2Text,
    nextSegment2Speaker,
  }: {
    actualTranscription: string;
    actualTranscriptionSpeaker: string;
    wordsWithSilences: string;
    segmentDuration: number;
    targetLanguage: AllowedLanguages;
    transcriptionLanguage: string;
    transcriptionSummary: string;
    segmentSummary?: string;
    videoSummary?: string;
    previousSegment1Text: string;
    previousSegment1Speaker: string;
    previousSegment2Text: string;
    previousSegment2Speaker: string;
    nextSegment1Text: string;
    nextSegment1Speaker: string;
    nextSegment2Text: string;
    nextSegment2Speaker: string;
  }) {
    const originalLanguage = (transcriptionLanguage as AudioOriginalLangAllowed) || 'auto-detect';
    const visemesArray = textToVisemes({
      text: actualTranscription,
      lang: originalLanguage,
    });
    const visemes = visemesToString(visemesArray);

    const prompt = PromptBuilder.createPromptToTranslateSegmentWithSmartSync({
      segmentText: actualTranscription,
      originalLanguage,
      visemes,
      videoSummary: videoSummary || '',
      segmentSummary: segmentSummary || '',
      previousSegment2Text,
      previousSegment2Speaker,
      previousSegment1Text,
      previousSegment1Speaker,
      targetLanguage: targetLanguage,
      nextSegment1Speaker,
      nextSegment1Text,
      nextSegment2Speaker,
      nextSegment2Text,
      segmentSpeaker: actualTranscriptionSpeaker,
      segmentDuration,
      wordsWithSilences,
      customTranslationInstructions: undefined,
    });

    return this.translateWithLLM({
      prompt,
      instruction: defaultInstructions,
      temperature: 0.5,
    });
  }

  static async translateWithLLM({
    prompt,
    temperature,
    instruction,
    responseFormat = 'text',
  }: {
    prompt: string;
    temperature: number;
    instruction: string;
    responseFormat?: 'text' | 'json';
  }) {
    let model: OpenAIModel = models.gpt5_2;

    try {
      return await requestToGPT({
        prompt,
        temperature,
        instructions: instruction,
        model,
        responseFormat: responseFormat === 'json' ? 'json_object' : 'text',
        reasoningEffort: 'none',
      });
    } catch (error) {
      console.error(error);
      throw new Error('Error while translating transcription');
    }
  }
}
