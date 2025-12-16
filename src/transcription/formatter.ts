import type {
  AllowedLanguages,
  AudioOriginalLangAllowed,
  SegmentDetail,
  SegmentDetailOut,
  SegmentDetailOutWithDuration,
} from '../types/index';
import type { SpeechmaticsFormattedResponse, SpeechmaticsSegment } from '../types/speechmatics';
import { maxCharactersPerSegmentForNonLatinScriptLanguages, threshold } from '../utils/config';
import { maxCharactersPerSegment } from '../utils/config';
import { languageCodes, nonLatinScriptLanguages } from '../utils/constants';
import { splitTooLongSegments } from './speechmaticsUtils';

export class Formatter {
  static formatTranscription(
    transcription: SpeechmaticsFormattedResponse,
    detectedLanguage: AudioOriginalLangAllowed,
  ): SegmentDetailOutWithDuration[] {
    const splitSegments = splitTooLongSegments(transcription.segments);
    const formattedSegments = this.convertSpeechmaticsToSegmentDetail(splitSegments, detectedLanguage);
    const mergedSegments = this.mergeSegments(formattedSegments, threshold);
    const finalTranscription = this.addDurationForEachTranscription(mergedSegments);

    return finalTranscription;
  }

  static convertSpeechmaticsToSegmentDetail(
    segments: SpeechmaticsSegment[],
    detectedLanguage: AudioOriginalLangAllowed,
  ): SegmentDetail[] {
    return segments.map((segment) => ({
      transcription: segment.transcription,
      begin: segment.begin,
      end: segment.end,
      wordsWithSilence: segment.wordsWithSilence,
      speaker: segment.speaker,
      channel: segment.channel,
      confidence: segment.confidence,
      language: detectedLanguage,
    }));
  }

  static mergeSegments(segments: SegmentDetail[], timeThreshold: number): SegmentDetailOut[] {
    console.debug('Merging segments...');
    const mergedSegments = this.mergeUnderCondition(segments, timeThreshold);

    return mergedSegments;
  }

  static getMaxCharactersPerSegment(language: string): number {
    const languageCode = languageCodes[language as keyof typeof languageCodes]?.toLowerCase();
    return nonLatinScriptLanguages.includes(languageCode as AllowedLanguages)
      ? maxCharactersPerSegmentForNonLatinScriptLanguages
      : maxCharactersPerSegment;
  }

  static mergeUnderCondition(segments: SegmentDetail[], timeThreshold: number) {
    const getMergedTranscription = () => {
      const mergedSegments: SegmentDetailOut[] = [];
      let currentSegment = segments[0];
      let mergedPartIndex = 0;

      if (segments.length === 0) throw new Error('No transcription found in the response.');

      for (let i = 1; i < segments.length; i++) {
        const nextSegment = segments[i];
        const maxChars = this.getMaxCharactersPerSegment(nextSegment.language);
        const difference = nextSegment.begin - currentSegment.end;

        if (
          difference <= timeThreshold &&
          currentSegment.speaker === nextSegment.speaker &&
          currentSegment.transcription.length + nextSegment.transcription.length < maxChars
        ) {
          currentSegment = {
            ...currentSegment,
            transcription: currentSegment.transcription + ' ' + nextSegment.transcription,
            end: nextSegment.end,
            wordsWithSilence: currentSegment.wordsWithSilence.concat(nextSegment.wordsWithSilence),
          };
        } else {
          mergedSegments.push({
            ...currentSegment,
            index: mergedPartIndex,
          });
          currentSegment = nextSegment;
          mergedPartIndex++;
        }
      }

      mergedSegments.push({
        ...currentSegment,
        index: mergedPartIndex,
      });

      return mergedSegments;
    };

    const finalMergedTranscriptions = getMergedTranscription();

    const isEverySegmentsLessThan4000 = finalMergedTranscriptions.every(
      (transcription) => transcription.transcription.length < 4000,
    );
    if (!isEverySegmentsLessThan4000) {
      console.error('Error while merging transcriptions: One of the transcription is too long (>4000)');
      throw new Error('One of the transcription is too long (>4000)');
    } else {
      return finalMergedTranscriptions;
    }
  }

  static addDurationForEachTranscription(transcription: SegmentDetail[]): SegmentDetailOutWithDuration[] {
    return transcription.map((part, index) => {
      const duration = part.end - part.begin;
      return {
        ...part,
        duration: Number(duration.toFixed(3)),
        index,
      };
    });
  }
}
