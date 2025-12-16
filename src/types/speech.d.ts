import type { AllowedLanguages, AudioOriginalLangAllowed } from './index';

export interface SpeechResponseWithIndex {
  speech: Response | Buffer;
  index: number;
  speaker: number;
  requestId: string;
}

export interface SpeechResponseWithDuration {
  speech: Buffer;
  duration: number;
  speechIndex: number;
  speaker: number;
  requestId: string;
}

export interface SpeechAdjusted {
  speech: Buffer | undefined;
  transcriptionDuration: number;
  end: number;
  begin: number;
  speaker: number;
  speechDuration: number;
  isSegmentTimestampAdjusted?: boolean;
  finalText: string;
}

export interface CreateLongerSpeechArguments {
  translatedTranscription: string;
  speechIndex: number;
  speakerIndex: number;
  targetLanguage: AllowedLanguages;
  originalLanguage: string;
  transcriptionWords: string;
  previousText: string;
  nextText: string;
  originalSegmentDuration: number;
  translatedSpeechDuration: number;
  difference: string;
  clonedVoiceId: string;
}

export interface CreateShorterSpeechArguments {
  translatedTranscription: string;
  speechIndex: number;
  speakerIndex: number;
  targetLanguage: AllowedLanguages;
  originalLanguage: AudioOriginalLangAllowed | 'auto-detect';
  wordsWithSilences: string;
  previousText: string;
  nextText: string;
  transcriptionDuration: number;
  translatedSpeechDuration: number;
  difference: string;
  clonedVoiceId: string;
}
