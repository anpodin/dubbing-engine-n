import { BatchClient, type TranscriptionConfig } from '@speechmatics/batch-client';
import { openAsBlob } from 'node:fs';
import type { SpeechmaticsTranscriptionResponse, SpeechmaticsFormattedResponse } from '../types/speechmatics';
import { formatSpeechmaticsResponse } from './speechmaticsUtils';
import { WhisperTranscriber } from './whisperTranscriber';

interface ExtendedTranscriptionConfig extends TranscriptionConfig {
  audio_filtering_config?: {
    volume_threshold?: number;
  };
  speaker_diarization_config?: {
    speaker_sensitivity?: number;
    max_speakers?: number;
  };
}

export class Transcriber {
  private static client: BatchClient | null = null;

  private static useLocalWhisper(): boolean {
    return process.env.USE_LOCAL_WHISPER === 'true';
  }

  private static getClient(): BatchClient {
    if (this.client) {
      return this.client;
    }

    const apiKey = process.env.SPEECHMATICS_API_KEY;
    if (!apiKey) {
      throw new Error('SPEECHMATICS_API_KEY is not defined in environment variables');
    }

    this.client = new BatchClient({ apiKey, appId: 'dubbing-engine' });
    return this.client;
  }

  static async transcribeAudio({ audioPath }: { audioPath: string }): Promise<SpeechmaticsFormattedResponse> {
    if (this.useLocalWhisper()) {
      console.info('Transcription mode: Local Whisper (open-source)');
      return WhisperTranscriber.transcribeAudio({ audioPath, originalLanguage: 'auto' });
    }

    try {
      console.info('Transcription mode: Speechmatics API');
      console.debug('Starting transcription with Speechmatics...');

      const transcription_config: ExtendedTranscriptionConfig = {
        language: 'auto',
        diarization: 'speaker',
        punctuation_overrides: {
          sensitivity: 0.53,
        },
        operating_point: 'enhanced',
        enable_entities: true,
        speaker_diarization_config: {
          speaker_sensitivity: 0.55,
        },
        audio_filtering_config: {
          volume_threshold: 1,
        },
      };

      const config = {
        type: 'transcription' as const,
        transcription_config,
        summarization_config: {},
      };

      const blob = await openAsBlob(audioPath);
      const filename = audioPath.split('/').pop() || 'audio.wav';
      const file = new File([blob], filename);

      console.debug(`Sending transcription request to Speechmatics... file: ${audioPath}`);

      const client = this.getClient();
      const response = await client.transcribe(file, config, 'json-v2');

      console.debug('Speechmatics transcription finished!');

      const rawResponse = response as SpeechmaticsTranscriptionResponse;
      const formattedResponse = formatSpeechmaticsResponse(rawResponse);

      console.debug(`Detected language: ${formattedResponse.detectedLanguage}`);
      console.debug(`Number of segments: ${formattedResponse.segments.length}`);

      return formattedResponse;
    } catch (error: any) {
      if (error.message && error.message.includes('not valid JSON')) {
        console.error('Speechmatics API returned HTML instead of JSON - check SPEECHMATICS_API_KEY');
        throw new Error('Speechmatics API authentication failed');
      }

      console.error('Speechmatics transcription error:', error);
      throw new Error(`Error in Speechmatics transcription: ${error.message || error}`);
    }
  }

  static async transcribeRaw({
    audioPath,
    originalLanguage = 'auto',
  }: {
    audioPath: string;
    originalLanguage?: string;
  }): Promise<SpeechmaticsTranscriptionResponse> {
    if (this.useLocalWhisper()) {
      console.info('Transcription mode: Local Whisper (open-source)');
      return WhisperTranscriber.transcribeRaw({ audioPath, originalLanguage });
    }

    try {
      console.info('Transcription mode: Speechmatics API');
      console.debug('Starting raw transcription with Speechmatics...');

      const transcription_config: ExtendedTranscriptionConfig = {
        language: originalLanguage === 'auto-detect' ? 'auto' : originalLanguage,
        diarization: 'none',
        punctuation_overrides: {
          sensitivity: 0.7,
        },
        operating_point: 'enhanced',
        enable_entities: true,
      };

      const config = {
        type: 'transcription' as const,
        transcription_config,
        summarization_config: {},
      };

      const blob = await openAsBlob(audioPath);
      const filename = audioPath.split('/').pop() || 'audio.wav';
      const file = new File([blob], filename);

      console.debug(`Sending raw transcription request to Speechmatics... file: ${audioPath}`);

      const client = this.getClient();
      const response = await client.transcribe(file, config, 'json-v2');

      console.debug('Speechmatics raw transcription finished!');

      return response as SpeechmaticsTranscriptionResponse;
    } catch (error: any) {
      if (error.message && error.message.includes('not valid JSON')) {
        console.error('Speechmatics API returned HTML instead of JSON - check SPEECHMATICS_API_KEY');
        throw new Error('Speechmatics API authentication failed');
      }

      console.error('Speechmatics raw transcription error:', error);
      throw new Error(`Error in Speechmatics transcription (raw): ${error.message || error}`);
    }
  }
}
