export interface SpeechmaticsWord {
  content: string;
  start_time: number;
  end_time: number;
  confidence: number;
  type: 'word' | 'punctuation';
  alternatives?: Array<{ content: string; confidence: number }>;
  language?: string;
  attaches_to?: 'next' | 'previous' | 'both' | 'none';
  is_eos?: boolean;
}

export interface SpeechmaticsSpeaker {
  speaker: string;
  start_time: number;
  end_time: number;
}

export interface SpeechmaticsMetadata {
  created_at: string;
  type: string;
  transcription_config: {
    language: string;
    operating_point?: string;
    diarization?: string;
    enable_entities?: boolean;
    output_locale?: string;
    additional_vocab?: Array<{ content: string; sounds_like?: string[] }>;
  };
  audio_format?: {
    channels: number;
    encoding: string;
    sample_rate: number;
  };
  language_pack_info?: {
    adapted: boolean;
    itn: boolean;
    language_description: string;
    word_delimiter: string;
  };
}

export interface SpeechmaticsResult {
  alternatives: Array<{
    content: string;
    confidence: number;
    display?: { direction: string };
    language?: string;
    speaker?: string;
    tags?: string[];
  }>;
  attaches_to?: string;
  end_time: number;
  is_eos?: boolean;
  start_time: number;
  type: 'word' | 'punctuation';
}

export interface SpeechmaticsSummarizationResult {
  content: string;
  start_time: number;
  end_time: number;
}

export interface SpeechmaticsTranscriptionResponse {
  format: string;
  job: {
    created_at: string;
    data_name: string;
    duration: number;
    id: string;
  };
  metadata: SpeechmaticsMetadata;
  results: SpeechmaticsResult[];
  speakers?: SpeechmaticsSpeaker[];
  summarization?: {
    content: string;
  };
}

export interface SpeechmaticsSegment {
  transcription: string;
  begin: number;
  end: number;
  speaker: number;
  channel: number;
  confidence: number;
  language: string;
  duration: number;
  index: number;
  wordsWithSilence: string;
  words: SpeechmaticsWord[];
}

export interface SpeechmaticsFormattedResponse {
  segments: SpeechmaticsSegment[];
  detectedLanguage: string;
  summary: string;
  audioDuration: number;
}
