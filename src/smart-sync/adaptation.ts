import { models } from '../llm/openai';
import { requestToGPT } from '../llm/openai';
import { PromptBuilder, defaultInstructions } from '../llm/prompt-builder';
import type {
  AllowedLanguages,
  AudioOriginalLangAllowed,
  SegmentWitDurationAndOriginalSegment,
  NewSegmentTimestamps,
} from '../types';
import type {
  CreateLongerSpeechArguments,
  CreateShorterSpeechArguments,
  SpeechAdjusted,
  SpeechResponseWithDuration,
} from '../types/speech';
import {
  silenceBetweenSegmentConsideredAsPause,
  minGapForTimestampExtension,
  maxTimestampExtensionWithFace,
  maxTimestampExtensionNoFace,
} from '../utils/config';
import { AudioUtils } from '../ffmpeg/audio-utils';
import { SpeechGenerator } from '../speech/speechGenerator';
import { GeminiService } from '../gemini/gemini';
import { detectFaceInVideoSegment } from '../gemini/video-analyzer';
import type { Readable } from 'form-data';
import fs from 'fs';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import { pathExists, safeUnlink } from '../utils/fsUtils';

export class Adaptation {
  constructor() {
    //
  }

  static async compareAndAdjustSpeeches({
    transcriptions,
    speeches,
    clonedVoicesIds,
    originalLanguage,
    targetLanguage,
    transcriptionSummary,
    videoPath,
    geminiService,
    fileType,
    disableExternalLlm = false,
  }: {
    transcriptions: SegmentWitDurationAndOriginalSegment[];
    speeches: SpeechResponseWithDuration[];
    clonedVoicesIds: { [key: string]: string };
    originalLanguage: AudioOriginalLangAllowed;
    targetLanguage: AllowedLanguages;
    transcriptionSummary: string;
    videoPath?: string;
    geminiService?: GeminiService;
    fileType?: 'audio' | 'video';
    disableExternalLlm?: boolean;
  }): Promise<SpeechAdjusted[]> {
    console.debug('Comparing speeches, and adjusting length...');
    if (transcriptions.length !== speeches.length) {
      console.error('Array length mismatch');
      throw new Error('Array length mismatch');
    }

    const sortedSegments = transcriptions.sort((a, b) => a.index - b.index);

    const maxSpeedFactor = 1.15;

    const minSpeedFactor = 0.9;

    let previousTranscriptionText = '';

    try {
      const adjustments: SpeechAdjusted[] = [];

      for (let index = 0; index < sortedSegments.length; index++) {
        let isSpeechModifiedToBeLonger = false;
        const transcription = sortedSegments[index];
        const speech = speeches[transcription.index];
        let speechBuffer = speech.speech;

        let newSpeechDuration = speech.duration;

        let speedFactor = newSpeechDuration / transcription.duration;
        let adjustedSpeedFactor = speedFactor;
        let reformulationAttempts = 0;
        const clonedVoiceId = clonedVoicesIds[transcription.speaker];

        let transcriptionText = transcription.transcription;
        let nextTranscriptionText = '';

        //next transcription text
        if (index + 1 < sortedSegments.length) {
          const silenceBetweenNextTranscription = sortedSegments[index + 1].begin - transcription.end;

          //1 = 1 second
          if (
            silenceBetweenNextTranscription > silenceBetweenSegmentConsideredAsPause ||
            sortedSegments[index + 1].speaker !== transcription.speaker
          ) {
            nextTranscriptionText = '';
          } else {
            nextTranscriptionText = sortedSegments[index + 1].transcription;
          }
        }

        const activateSmartSync = !disableExternalLlm;
        const offlineMinSpeedFactor = Number(process.env.OFFLINE_TTS_MIN_SPEED_FACTOR || 0.85);
        const offlineMaxSpeedFactor = Number(process.env.OFFLINE_TTS_MAX_SPEED_FACTOR || 1.15);

        if (disableExternalLlm) {
          adjustedSpeedFactor = Math.min(Math.max(speedFactor, offlineMinSpeedFactor), offlineMaxSpeedFactor);
          console.debug(
            `External LLM disabled: clamping speed factor ${speedFactor.toFixed(3)} -> ${adjustedSpeedFactor.toFixed(3)}`,
          );
        }

        let isSegmentTimestampAdjusted = false;
        let adjustedBegin = transcription.begin;
        let adjustedEnd = transcription.end;
        let adjustedTranscriptionDuration = transcription.duration;

        if (
          activateSmartSync &&
          speedFactor > maxSpeedFactor &&
          fileType === 'video' &&
          videoPath &&
          geminiService
        ) {
          console.debug(`Too long (speedFactor: ${speedFactor}), trying timestamp adjustment first...`);

          try {
            const timestampAdjustment = await this.tryTimestampAdjustment({
              currentSegment: transcription,
              previousSegment: index > 0 ? sortedSegments[index - 1] : undefined,
              nextSegment: index < sortedSegments.length - 1 ? sortedSegments[index + 1] : undefined,
              speechDuration: newSpeechDuration,
              maxSpeedFactor,
              videoPath,
              geminiService,
            });

            if (timestampAdjustment) {
              adjustedBegin = timestampAdjustment.newBegin;
              adjustedEnd = timestampAdjustment.newEnd;
              adjustedTranscriptionDuration = timestampAdjustment.newDuration;
              isSegmentTimestampAdjusted = true;

              speedFactor = newSpeechDuration / adjustedTranscriptionDuration;
              adjustedSpeedFactor = speedFactor;

              console.debug(
                `Timestamp adjustment applied: ${transcription.begin.toFixed(2)}s-${transcription.end.toFixed(2)}s -> ${adjustedBegin.toFixed(2)}s-${adjustedEnd.toFixed(2)}s (new speedFactor: ${speedFactor.toFixed(3)})`,
              );
            }
          } catch (err) {
            console.error('Timestamp adjustment failed, will proceed with reformulation:', err);
          }
        }

        const smartSyncMustBeTriggered =
          activateSmartSync && (speedFactor > maxSpeedFactor || speedFactor < minSpeedFactor);

        while (smartSyncMustBeTriggered && reformulationAttempts < 2) {
          if (speedFactor > maxSpeedFactor) {
            console.debug(`Too long (speedFactor: ${speedFactor}), reformulation needed`);

            const shorterSpeech = await this.createShorterSpeech({
              translatedTranscription: transcriptionText,
              speechIndex: transcription.index,
              speakerIndex: transcription.speaker,
              targetLanguage: targetLanguage,
              originalLanguage: originalLanguage,
              wordsWithSilences: transcription.wordsWithSilence,
              previousText: previousTranscriptionText,
              nextText: nextTranscriptionText,
              transcriptionDuration: adjustedTranscriptionDuration,
              translatedSpeechDuration: newSpeechDuration,
              difference: (newSpeechDuration - adjustedTranscriptionDuration).toFixed(2),
              clonedVoiceId,
            });

            transcriptionText = shorterSpeech.reformulatedText as string;

            speechBuffer = shorterSpeech.speech;
            newSpeechDuration = shorterSpeech.duration;
          } else if (speedFactor < minSpeedFactor) {
            console.debug(`Too short (speedFactor: ${speedFactor}), reformulation needed`);
            const longerSpeech = await this.createLongerSpeech({
              translatedTranscription: transcriptionText,
              speechIndex: transcription.index,
              speakerIndex: transcription.speaker,
              targetLanguage: targetLanguage,
              originalLanguage: originalLanguage,
              transcriptionWords: transcription.wordsWithSilence,
              previousText: previousTranscriptionText,
              nextText: nextTranscriptionText,
              originalSegmentDuration: adjustedTranscriptionDuration,
              translatedSpeechDuration: newSpeechDuration,
              difference: (adjustedTranscriptionDuration - newSpeechDuration).toFixed(2),
              clonedVoiceId,
            });

            transcriptionText = longerSpeech.longerText;

            speechBuffer = longerSpeech.speech;
            newSpeechDuration = longerSpeech.duration;
            isSpeechModifiedToBeLonger = true;
          }

          speedFactor = newSpeechDuration / adjustedTranscriptionDuration;

          adjustedSpeedFactor = Math.min(Math.max(speedFactor, minSpeedFactor), maxSpeedFactor);
          reformulationAttempts++;

          console.debug(
            `Reformulation attempt ${reformulationAttempts}: adjustedSpeedFactor = ${adjustedSpeedFactor}`,
          );
        }

        previousTranscriptionText = transcriptionText;

        const adjustedSpeech = await this.adjustSpeechSpeed(speechBuffer, adjustedSpeedFactor);

        const newSpeechDurationAdjusted = await this.getSpeechDuration(adjustedSpeech);

        if (typeof newSpeechDurationAdjusted !== 'number')
          throw new Error(
            `Error during audio duration calculation in compareAndAdjustSpeeches: duration is not a number: ${newSpeechDurationAdjusted}`,
          );

        adjustments.push({
          speech: adjustedSpeech,
          transcriptionDuration: adjustedTranscriptionDuration,
          end: adjustedEnd,
          begin: adjustedBegin,
          speaker: transcription.speaker,
          speechDuration: newSpeechDurationAdjusted,
          isSegmentTimestampAdjusted,
          finalText: transcriptionText,
        });
      }

      return adjustments;
    } catch (err: unknown) {
      console.error(err);
      throw new Error('Error while adjusting speeches');
    }
  }

  static async adjustSpeechSpeed(speech: Buffer, speedFactor: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (speedFactor < 0.5 || speedFactor > 2.0) {
        console.error('Speed factor must be between 0.5 and 2.0');
        reject(new Error('Speed factor must be between 0.5 and 2.0'));
        return;
      }

      if (speedFactor === 1) {
        console.debug('speedFactor is 1');
        resolve(speech);
        return;
      }

      return AudioUtils.adjustSpeed(speech, speedFactor).then(resolve).catch(reject);
    });
  }

  static async getSpeechDuration(speech: Readable | Buffer): Promise<number | 'N/A'> {
    try {
      const duration = await AudioUtils.getAudioDurationFromBuffer(speech);
      return duration;
    } catch (err) {
      console.error('Speech duration error : ' + err);
      throw new Error('Error while getting speech duration');
    }
  }

  static async createShorterSpeech({
    translatedTranscription,
    speechIndex,
    speakerIndex,
    targetLanguage,
    originalLanguage,
    wordsWithSilences,
    previousText,
    nextText,
    transcriptionDuration,
    translatedSpeechDuration,
    difference,
    clonedVoiceId,
  }: CreateShorterSpeechArguments) {
    const reformulatedTranscription = await this.getReformulatedTranscription({
      targetLanguage,
      transcriptionDuration,
      translatedSpeechDuration,
      difference,
      originalLanguage,
      wordsWithSilences,
      translatedTranscription,
      isSecondTry: false,
    });

    const speechShortened = await SpeechGenerator.getSpeechFromTTSEngine({
      transcription: reformulatedTranscription as string,
      index: speechIndex,
      speakerIndex: speakerIndex,
      clonedVoiceId: clonedVoiceId,
      options: {
        previousTranscriptionText: previousText,
        nextTranscriptionText: nextText,
      },
      targetLanguage,
    });

    const speechBuffer =
      speechShortened.speech instanceof Response
        ? Buffer.from(await speechShortened.speech.arrayBuffer())
        : speechShortened.speech;

    const speechBufferWithoutSilence = await this.removeStartAndEndSilenceFromAudio(speechBuffer);

    const speechDuration = await this.getSpeechDuration(speechBufferWithoutSilence);

    if (typeof speechDuration !== 'number')
      throw new Error(
        `Error during audio duration calculation in createShorterSpeech: duration is not a number: ${speechDuration}`,
      );

    console.debug('Shorter speech created.');

    return {
      speech: speechBufferWithoutSilence,
      duration: speechDuration,
      reformulatedText: reformulatedTranscription,
      requestId: speechShortened.requestId,
    };
  }

  static async removeStartAndEndSilenceFromAudio(speech: Buffer): Promise<Buffer> {
    const temporaryInputFile = `temporary-files/input-for-trim-${crypto.randomUUID()}.wav`;
    const temporaryOutputFile = `temporary-files/output-for-trim-${crypto.randomUUID()}.wav`;

    try {
      await fsPromises.writeFile(temporaryInputFile, speech);

      try {
        await AudioUtils.removeStartAndEndSilenceFromAudioWithFFMPEG(temporaryInputFile, temporaryOutputFile);
      } catch (ffmpegError: any) {
        console.error('FFmpeg error during silence removal:', ffmpegError);

        if (!(await pathExists(temporaryOutputFile))) {
          throw new Error(`FFmpeg failed to process audio: ${ffmpegError.message || 'Unknown error'}`);
        }

        console.debug('FFmpeg reported an error but output file exists, attempting to continue');
      }

      if (!(await pathExists(temporaryOutputFile))) {
        throw new Error('Output file was not created during silence removal');
      }

      const stats = await fsPromises.stat(temporaryOutputFile);
      if (stats.size === 0) {
        throw new Error('Output file is empty after silence removal');
      }

      const bufferNewSpeech = await fsPromises.readFile(temporaryOutputFile);

      return bufferNewSpeech;
    } catch (err: any) {
      console.error('Error in removeStartAndEndSilenceFromAudio:', err);
      throw new Error(
        `ERROR while removing start and end silence from audio: ${err.message || 'Unknown error'}`,
      );
    } finally {
      try {
        await safeUnlink(temporaryInputFile);
      } catch (unlinkError) {
        console.error('Error deleting temporary input file:', unlinkError);
      }

      try {
        await safeUnlink(temporaryOutputFile);
      } catch (unlinkError) {
        console.error('Error deleting temporary output file:', unlinkError);
      }
    }
  }

  static async requestUpdatedTextToAi({ prompt, instruction }: { prompt: string; instruction: string }) {
    try {
      const response = await requestToGPT({
        prompt,
        temperature: 0.5,
        instructions: instruction,
        responseFormat: 'text',
        model: models.gpt5_2,
        reasoningEffort: 'low',
      });

      return response;
    } catch (error) {
      console.error('Error requesting updated text to AI with fallback (1) :', error);

      throw new Error('Error requesting updated text to AI with fallback (1)');
    }
  }

  static async getReformulatedTranscription({
    targetLanguage,
    transcriptionDuration,
    translatedSpeechDuration,
    difference,
    originalLanguage,
    wordsWithSilences,
    translatedTranscription,
    isSecondTry = false,
  }: {
    targetLanguage: string;
    transcriptionDuration: number;
    translatedSpeechDuration: number;
    difference: string;
    originalLanguage: AudioOriginalLangAllowed | 'auto-detect';
    wordsWithSilences: string;
    translatedTranscription: string;
    isSecondTry?: boolean;
  }) {
    const promptForLLM = PromptBuilder.createPromptForReformulatedTranscription({
      targetLanguage,
      transcriptionDuration,
      translatedSpeechDuration,
      difference,
      originalLanguage,
      wordsWithSilences,
      translatedTranscription,
      isSecondTry,
    });

    const LLMResponse = await this.requestUpdatedTextToAi({
      prompt: promptForLLM,
      instruction: defaultInstructions,
    });

    return LLMResponse;
  }

  static async getLongerText({
    difference,
    targetLanguage,
    originalLanguage,
    transcriptionWords,
    translatedTranscription,
    originalSegmentDuration,
    translatedSpeechDuration,
    isNewTry = false,
  }: {
    difference: string;
    targetLanguage: string;
    originalLanguage: string;
    transcriptionWords: string;
    translatedTranscription: string;
    originalSegmentDuration: number;
    translatedSpeechDuration: number;
    isNewTry?: boolean;
  }) {
    const prompt = PromptBuilder.createPromptForHandlingTooShortSpeech({
      targetLanguage: targetLanguage,
      orignalLanguage: originalLanguage,
      wordsWithSilences: transcriptionWords,
      translatedTranscription,
      originalSegmentDuration,
      difference,
      speechDuration: translatedSpeechDuration,
      isNewTry,
    });

    const translatedTextWithSilence = await this.requestUpdatedTextToAi({
      prompt,
      instruction: defaultInstructions,
    });

    return translatedTextWithSilence;
  }

  static async createLongerSpeech({
    translatedTranscription,
    speechIndex,
    speakerIndex,
    targetLanguage,
    originalLanguage,
    transcriptionWords,
    nextText,
    previousText,
    originalSegmentDuration,
    translatedSpeechDuration,
    difference,
    clonedVoiceId,
  }: CreateLongerSpeechArguments): Promise<{
    speech: Buffer;
    duration: number;
    requestId: string;
    longerText: string;
  }> {
    const translatedTextWithSilence = await this.getLongerText({
      difference,
      targetLanguage,
      originalLanguage,
      transcriptionWords,
      translatedTranscription,
      originalSegmentDuration,
      translatedSpeechDuration,
      isNewTry: false,
    });

    const longerSpeech = await SpeechGenerator.getSpeechFromTTSEngine({
      transcription: translatedTextWithSilence as string,
      index: speechIndex,
      speakerIndex: speakerIndex,
      clonedVoiceId,
      options: {
        previousTranscriptionText: previousText,
        nextTranscriptionText: nextText,
      },
      targetLanguage,
    });

    const speechBuffer =
      longerSpeech.speech instanceof Response
        ? Buffer.from(await longerSpeech.speech.arrayBuffer())
        : longerSpeech.speech;

    const speechBufferWithoutSilence = await this.removeStartAndEndSilenceFromAudio(speechBuffer);

    const speechDuration = await this.getSpeechDuration(speechBufferWithoutSilence);

    if (typeof speechDuration !== 'number')
      throw new Error(
        `Error during audio duration calculation in translation service: duration is not a number: ${speechDuration}`,
      );

    return {
      speech: speechBufferWithoutSilence,
      duration: speechDuration,
      requestId: longerSpeech.requestId,
      longerText: translatedTextWithSilence,
    };
  }

  /**
   * Calculate available gaps before and after a segment
   * Returns usable gaps that are >= minGapForTimestampExtension
   */
  static calculateAvailableGaps({
    currentSegment,
    previousSegment,
    nextSegment,
  }: {
    currentSegment: SegmentWitDurationAndOriginalSegment;
    previousSegment?: SegmentWitDurationAndOriginalSegment;
    nextSegment?: SegmentWitDurationAndOriginalSegment;
  }): { gapBefore: number; gapAfter: number } {
    // Gap before current segment
    let gapBefore = 0;
    if (previousSegment) {
      gapBefore = currentSegment.begin - previousSegment.end;
    } else {
      // First segment - can extend to 0
      gapBefore = currentSegment.begin;
    }

    // Gap after current segment
    let gapAfter = 0;
    if (nextSegment) {
      gapAfter = nextSegment.begin - currentSegment.end;
    } else {
      // Last segment - allow some extension (max configured value)
      gapAfter = maxTimestampExtensionNoFace;
    }

    // Only return usable gaps
    return {
      gapBefore:
        gapBefore >= minGapForTimestampExtension ? Math.min(gapBefore, maxTimestampExtensionNoFace) : 0,
      gapAfter: gapAfter >= minGapForTimestampExtension ? Math.min(gapAfter, maxTimestampExtensionNoFace) : 0,
    };
  }

  /**
   * Try to adjust segment timestamps to accommodate longer speech
   * Uses face detection to determine how much extension is safe
   */
  static async tryTimestampAdjustment({
    currentSegment,
    previousSegment,
    nextSegment,
    speechDuration,
    maxSpeedFactor,
    videoPath,
    geminiService,
  }: {
    currentSegment: SegmentWitDurationAndOriginalSegment;
    previousSegment?: SegmentWitDurationAndOriginalSegment;
    nextSegment?: SegmentWitDurationAndOriginalSegment;
    speechDuration: number;
    maxSpeedFactor: number;
    videoPath: string;
    geminiService: GeminiService;
  }): Promise<NewSegmentTimestamps | null> {
    const { gapBefore, gapAfter } = this.calculateAvailableGaps({
      currentSegment,
      previousSegment,
      nextSegment,
    });

    // If no gaps available, can't adjust
    if (gapBefore === 0 && gapAfter === 0) {
      console.debug('No gaps available for timestamp adjustment');
      return null;
    }

    // Calculate how much duration we need
    const neededDuration = speechDuration / maxSpeedFactor;
    const neededExtension = neededDuration - currentSegment.duration;

    if (neededExtension <= 0) {
      // No extension needed
      return null;
    }

    // Run face detection in parallel for both boundaries (if gaps exist)
    const faceDetectionPromises: Promise<boolean>[] = [];

    if (gapBefore > 0) {
      // Check 0.3s before segment start
      const checkStart = Math.max(0, currentSegment.begin - 0.3);
      const checkEnd = currentSegment.begin;
      faceDetectionPromises.push(detectFaceInVideoSegment(videoPath, checkStart, checkEnd, geminiService));
    } else {
      faceDetectionPromises.push(Promise.resolve(true)); // Conservative default
    }

    if (gapAfter > 0) {
      // Check 0.3s after segment end
      const checkStart = currentSegment.end;
      const checkEnd = currentSegment.end + 0.3;
      faceDetectionPromises.push(detectFaceInVideoSegment(videoPath, checkStart, checkEnd, geminiService));
    } else {
      faceDetectionPromises.push(Promise.resolve(true)); // Conservative default
    }

    const [faceAtStart, faceAtEnd] = await Promise.all(faceDetectionPromises);

    // Determine max extension per side based on face detection
    const maxExtensionBefore = faceAtStart ? maxTimestampExtensionWithFace : maxTimestampExtensionNoFace;
    const maxExtensionAfter = faceAtEnd ? maxTimestampExtensionWithFace : maxTimestampExtensionNoFace;

    // Calculate actual extensions (try to split evenly, respect limits)
    const availableExtensionBefore = Math.min(gapBefore, maxExtensionBefore);
    const availableExtensionAfter = Math.min(gapAfter, maxExtensionAfter);
    const totalAvailableExtension = availableExtensionBefore + availableExtensionAfter;

    if (totalAvailableExtension < neededExtension * 0.5) {
      // Can't extend enough to make a meaningful difference
      console.debug(
        `Insufficient extension available: need ${neededExtension.toFixed(3)}s, have ${totalAvailableExtension.toFixed(3)}s`,
      );
      return null;
    }

    // Distribute extension evenly, respecting limits
    let extensionBefore = 0;
    let extensionAfter = 0;

    if (neededExtension <= totalAvailableExtension) {
      // We have enough space, distribute evenly
      const halfNeeded = neededExtension / 2;

      if (halfNeeded <= availableExtensionBefore && halfNeeded <= availableExtensionAfter) {
        // Both sides can handle half
        extensionBefore = halfNeeded;
        extensionAfter = halfNeeded;
      } else if (availableExtensionBefore < halfNeeded) {
        // Start side limited, use more from end
        extensionBefore = availableExtensionBefore;
        extensionAfter = Math.min(neededExtension - extensionBefore, availableExtensionAfter);
      } else {
        // End side limited, use more from start
        extensionAfter = availableExtensionAfter;
        extensionBefore = Math.min(neededExtension - extensionAfter, availableExtensionBefore);
      }
    } else {
      // Use all available space
      extensionBefore = availableExtensionBefore;
      extensionAfter = availableExtensionAfter;
    }

    const newBegin = currentSegment.begin - extensionBefore;
    const newEnd = currentSegment.end + extensionAfter;
    const newDuration = newEnd - newBegin;

    // Verify the new speed factor is acceptable
    const newSpeedFactor = speechDuration / newDuration;
    if (newSpeedFactor > maxSpeedFactor) {
      console.debug(
        `Timestamp adjustment insufficient: new speedFactor ${newSpeedFactor.toFixed(3)} still > ${maxSpeedFactor}`,
      );
      return null;
    }

    return {
      newBegin,
      newEnd,
      newDuration,
      extensionBefore,
      extensionAfter,
      faceDetectedAtStart: faceAtStart,
      faceDetectedAtEnd: faceAtEnd,
    };
  }
}
