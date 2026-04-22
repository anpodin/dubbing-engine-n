import { SubtitlesGenerator } from './../subtitles/subtitles-generator';
import { AudioUtils } from '../ffmpeg/audio-utils';
import { Helpers } from '../utils/helpers';
import { Transcriber } from '../transcription/transcriber';
import type { AllowedLanguages, AudioOriginalLangAllowed, TranscriptionDataTypes } from '../types';
import { Formatter } from '../transcription/formatter';
import TextTranslatorDefault, {
  TextTranslator as TextTranslatorNamed,
} from '../transcription/textTranslator';
import { AudioSeparator } from '../separator';
import { SpeechGenerator } from '../speech/speechGenerator';
import { Adaptation } from '../smart-sync/adaptation';
import { VideoUtils } from '../ffmpeg/video-utils';
import fsPromises from 'fs/promises';
import { Lipsync } from '../lipsync/lipsync';
import crypto from 'crypto';
import { safeUnlink } from '../utils/fsUtils';
import { GeminiService } from '../gemini/gemini';
import { getVideoGlobalContext, addVisualContextToSegments } from '../gemini/video-analyzer';
import { ElevenLabsClient } from 'elevenlabs';

export type DebugMode = 'yes' | 'no';
export type ActivateLipSync = 'yes' | 'no';
export type ActivateSubtitle = 'yes' | 'no';

const TextTranslator = TextTranslatorNamed || TextTranslatorDefault;

export const translate = async () => {
  const targetLanguage = (process.env.TARGET_LANGUAGE || 'english') as AllowedLanguages;
  const debugMode: DebugMode = (process.env.DEBUG_MODE as DebugMode) || 'no';
  const activateLipSync: ActivateLipSync = (process.env.APPLY_LIPSYNC as ActivateLipSync) || 'no';
  const activateSubtitle: ActivateSubtitle = (process.env.ACTIVATE_SUBTITLE as ActivateSubtitle) || 'yes';

  let clonedVoicesIdsToDelete: string[] = [];

  const transcriptionData: TranscriptionDataTypes = {
    summary: null,
    formattedSegments: [],
    detectedAudioLanguage: null,
  };

  if (debugMode === 'no') {
    console.debug = () => {};
    console.info('Dubbing Started successfully with the following parameters:');
    console.info('Target Language: ', targetLanguage);
    console.info('Debug Mode: ', debugMode);
    console.info('Activate Lip Sync: ', activateLipSync);
    console.info('Activate Subtitle: ', activateSubtitle);
  }

  Helpers.verifyPrerequisitesForDubbing();

  let inputFilePath = '';
  let videoPathWithoutAudio = null;
  let audioPathWithoutVideo = null;
  let backgroundAudio = null;
  let vocalsIsolated = null;

  try {
    inputFilePath = await Helpers.getAllInputFilePaths();
    const fileType = Helpers.getFileType(inputFilePath);

    console.info('File type: ', fileType);

    if (fileType === 'video') {
      const { videoPath, audioPath } = await AudioUtils.separateAudioAndVideo(inputFilePath);
      videoPathWithoutAudio = videoPath;
      audioPathWithoutVideo = audioPath;
    } else {
      const audioPathCopy = `temporary-files/original-audio-${crypto.randomUUID()}.wav`;
      await fsPromises.copyFile(inputFilePath, audioPathCopy);
      audioPathWithoutVideo = audioPathCopy;
    }

    const transcription = await Transcriber.transcribeAudio({
      audioPath: audioPathWithoutVideo,
    });

    transcriptionData.detectedAudioLanguage = transcription.detectedLanguage as AudioOriginalLangAllowed;

    const transcriptionSummary = transcription.summary || '';

    const formattedTranscription = Formatter.formatTranscription(
      transcription,
      transcriptionData.detectedAudioLanguage,
    );

    let videoSummary = '';
    let segmentsWithVisualContext = formattedTranscription;
    let geminiService: GeminiService | undefined;

    if (fileType === 'video' && inputFilePath) {
      try {
        geminiService = new GeminiService();

        console.info('Analyzing video for visual context...');
        videoSummary = await getVideoGlobalContext(inputFilePath, geminiService);

        console.info('Video summary: ', videoSummary);

        if (videoSummary) {
          segmentsWithVisualContext = await addVisualContextToSegments(
            formattedTranscription,
            inputFilePath,
            videoSummary,
            geminiService,
          );
        }

        console.info('Video analysis completed.');
      } catch (error) {
        console.error('Video analysis failed, continuing without visual context:', error);
      }
    }

    const translatedTranscription = await TextTranslator.translateTranscriptionInTargetLanguage({
      transcription: segmentsWithVisualContext,
      targetLanguage,
      originLanguage: transcriptionData.detectedAudioLanguage,
      transcriptionSummary: transcriptionSummary || '',
      videoSummary,
    });

    const verifiedTranscription = Helpers.parseAndVerifyTranscriptionDetails(
      JSON.stringify(translatedTranscription),
    );

    ({ backgroundAudio, vocalsIsolated } = await AudioSeparator.getSeparateAudio(audioPathWithoutVideo));
    const isolatedVocalsAverageDecibel = await AudioUtils.getAverageDecibel(vocalsIsolated);

    const { allResultsSorted, clonedVoicesIds } = await SpeechGenerator.getSpeechArrayFromTranscriptions({
      segments: verifiedTranscription,
      targetLanguage,
      isolatedVocalsPath: vocalsIsolated,
    });

    clonedVoicesIdsToDelete = Object.values(clonedVoicesIds);

    const speechWithDuration = await SpeechGenerator.getEachSpeechDuration({
      speechArray: allResultsSorted,
      transcriptions: verifiedTranscription,
    });

    const speechesWithoutSilence =
      await SpeechGenerator.removeStartAndEndSilenceFromAllAudio(speechWithDuration);

    const adaptedSpeeches = await Adaptation.compareAndAdjustSpeeches({
      transcriptions: verifiedTranscription,
      speeches: speechesWithoutSilence,
      clonedVoicesIds,
      originalLanguage: transcriptionData.detectedAudioLanguage,
      targetLanguage,
      transcriptionSummary,
      videoPath: inputFilePath,
      geminiService,
      fileType: fileType ?? undefined,
    });

    const finalVoicesAudioTrack =
      await SpeechGenerator.createAndAssembleSeparateAudioTracksEachSpeaker(adaptedSpeeches);

    const equalizedAudio = await AudioUtils.startEqualizeAudio(finalVoicesAudioTrack);

    await AudioUtils.adjustAudioToDecibel(equalizedAudio, isolatedVocalsAverageDecibel);

    const mergedAudio = await SpeechGenerator.overlayAudioAndBackgroundMusic(equalizedAudio, backgroundAudio);

    let finalContent = mergedAudio;

    if (fileType === 'video') {
      if (!videoPathWithoutAudio) {
        throw new Error('Video path is missing after separating audio and video');
      }

      finalContent = await VideoUtils.getAudioMergeWithVideo(videoPathWithoutAudio, mergedAudio);
    }

    if (fileType === 'video' && activateSubtitle === 'yes') {
      const transcriptionWithAdaptedText = verifiedTranscription.map((segment, idx) => ({
        ...segment,
        transcription: adaptedSpeeches[idx]?.finalText ?? segment.transcription,
      }));

      const filePathVideoSubtitles = await SubtitlesGenerator.addSubtitlesInVideo({
        transcriptionData: transcriptionWithAdaptedText,
        initialVideoPath: finalContent,
        lang: targetLanguage,
        audioPath: mergedAudio,
      });

      finalContent = filePathVideoSubtitles;
    }

    if (fileType === 'video' && activateLipSync === 'yes') {
      const lipSyncedVideoUrl = await Lipsync.processLipSyncWithAwsUpload({
        localAudioPath: mergedAudio,
        localVideoPath: finalContent,
      });

      const lipSyncedVideo = await fetch(lipSyncedVideoUrl).then((res) => res.arrayBuffer());
      const lipSyncedVideoBuffer = Buffer.from(lipSyncedVideo);
      const newFilePath = `output/result-${crypto.randomUUID()}.mp4`;
      await fsPromises.writeFile(newFilePath, lipSyncedVideoBuffer);

      finalContent = newFilePath;
    }

    if (fileType === 'video') {
      await safeUnlink(mergedAudio);
    }

    console.info('Translation completed successfully, you can now find your video in the output folder.');
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
    } else {
      console.error('Error:', error);
    }
  } finally {
    if (videoPathWithoutAudio) await safeUnlink(videoPathWithoutAudio);
    if (audioPathWithoutVideo) await safeUnlink(audioPathWithoutVideo);
    if (backgroundAudio) await safeUnlink(backgroundAudio);
    if (vocalsIsolated) await safeUnlink(vocalsIsolated);

    if (clonedVoicesIdsToDelete.length > 0) {
      console.info('Cleaning up cloned voices from ElevenLabs...');
      const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;
      if (elevenLabsApiKey) {
        const elevenLabsClient = new ElevenLabsClient({ apiKey: elevenLabsApiKey });
        for (const voiceId of clonedVoicesIdsToDelete) {
          try {
            await elevenLabsClient.voices.delete(voiceId);
            console.debug(`Deleted cloned voice: ${voiceId}`);
          } catch (err) {
            console.error(`Failed to delete cloned voice ${voiceId}:`, err);
          }
        }
      }
    }
  }
};

translate();
