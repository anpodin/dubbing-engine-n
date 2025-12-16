import crypto from 'crypto';
import fsPromises from 'fs/promises';
import { GeminiService, geminiModels } from './gemini';
import { PromptBuilder } from '../llm/prompt-builder';
import { VideoUtils } from '../ffmpeg/video-utils';
import { safeUnlink } from '../utils/fsUtils';
import {
  maxVideoDurationForSingleAnalysisMinutes,
  maxConcurrentGeminiChunkAnalysis,
  segmentAnalysisBatchSize,
} from '../utils/config';
import type { SegmentDetailOutWithDuration } from '../types';

/**
 * Format duration in seconds to human-readable string
 */
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get global video context by analyzing the entire video
 * For long videos (>25 min), chunks into segments and processes in parallel
 */
export async function getVideoGlobalContext(
  videoPath: string,
  geminiService: GeminiService,
): Promise<string> {
  console.debug('Starting global video analysis...');

  if (GeminiService.isAudioOnlyFile(videoPath)) {
    console.debug('Audio-only file detected, skipping video analysis');
    return '';
  }

  try {
    const videoDuration = await VideoUtils.getFileDuration(videoPath);

    if (videoDuration === 'N/A' || typeof videoDuration !== 'number') {
      console.error('Could not determine video duration');
      return '';
    }

    const videoDurationMinutes = videoDuration / 60;
    const prompt = PromptBuilder.createPromptToGetCleanedResumeOfVideo();

    // For short videos, analyze directly
    if (videoDurationMinutes <= maxVideoDurationForSingleAnalysisMinutes) {
      console.debug(`Analyzing video directly (${videoDurationMinutes.toFixed(1)} minutes)`);

      const summary = await geminiService.requestToGemini({
        prompt,
        model: geminiModels.gemini2_5flash,
        temperature: 0.7,
        filePath: videoPath,
        timeoutInMs: 600000,
      });

      console.debug('Global video analysis completed');
      return summary;
    }

    console.debug(`Long video detected (${videoDurationMinutes.toFixed(1)} min), chunking...`);

    const chunkDurationSeconds = maxVideoDurationForSingleAnalysisMinutes * 60;
    const chunks: { start: number; end: number }[] = [];

    for (let start = 0; start < videoDuration; start += chunkDurationSeconds) {
      const end = Math.min(start + chunkDurationSeconds, videoDuration);
      chunks.push({ start, end });
    }

    console.debug(`Created ${chunks.length} chunks for analysis`);

    const results: { chunk: { start: number; end: number }; summary: string }[] = [];

    for (let i = 0; i < chunks.length; i += maxConcurrentGeminiChunkAnalysis) {
      const batch = chunks.slice(i, i + maxConcurrentGeminiChunkAnalysis);

      const batchPromises = batch.map(async (chunk) => {
        const chunkPath = `temporary-files/chunk-${crypto.randomUUID()}.mp4`;

        try {
          await VideoUtils.cutVideo({
            inputFilePath: videoPath,
            startTime: Math.floor(chunk.start),
            endTime: Math.floor(chunk.end),
            outputFilePath: chunkPath,
          });

          const summary = await geminiService.requestToGemini({
            prompt,
            model: geminiModels.gemini2_5flash,
            temperature: 0.7,
            filePath: chunkPath,
            timeoutInMs: 600000,
          });

          return { chunk, summary };
        } catch (error) {
          console.error(
            `Failed to analyze chunk ${formatDuration(chunk.start)}-${formatDuration(chunk.end)}:`,
            error,
          );
          return { chunk, summary: '' };
        } finally {
          await safeUnlink(chunkPath);
        }
      });

      const batchResults = await Promise.allSettled(batchPromises);

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value.summary) {
          results.push(result.value);
        }
      }
    }

    const combinedSummary = results
      .sort((a, b) => a.chunk.start - b.chunk.start)
      .map((r) => `[${formatDuration(r.chunk.start)} - ${formatDuration(r.chunk.end)}]: ${r.summary}`)
      .join('\n\n');

    console.debug('Global video analysis completed (chunked)');
    return combinedSummary;
  } catch (error) {
    console.error('Error during global video analysis:', error);
    return '';
  }
}

/**
 * Add visual context to each segment by analyzing the corresponding video portion
 */
export async function addVisualContextToSegments(
  segments: SegmentDetailOutWithDuration[],
  videoPath: string,
  globalContext: string,
  geminiService: GeminiService,
): Promise<SegmentDetailOutWithDuration[]> {
  console.debug(`Adding visual context to ${segments.length} segments...`);

  if (GeminiService.isAudioOnlyFile(videoPath)) {
    console.debug('Audio-only file detected, skipping segment analysis');
    return segments;
  }

  const videoDuration = await VideoUtils.getFileDuration(videoPath);

  if (videoDuration === 'N/A' || typeof videoDuration !== 'number') {
    console.error('Could not determine video duration for segment analysis');
    return segments;
  }

  const results: SegmentDetailOutWithDuration[] = [];
  const prompt = PromptBuilder.createPromptToSummarizeSegment(globalContext);

  for (let i = 0; i < segments.length; i += segmentAnalysisBatchSize) {
    const batch = segments.slice(i, i + segmentAnalysisBatchSize);
    console.debug(
      `Processing segment batch ${Math.floor(i / segmentAnalysisBatchSize) + 1}/${Math.ceil(segments.length / segmentAnalysisBatchSize)}`,
    );

    const batchPromises = batch.map(async (segment) => {
      let startTime = Math.max(0, segment.begin);
      let endTime = Math.min(segment.end, videoDuration);

      if (endTime - startTime < 1) {
        if (endTime + 1 <= videoDuration) {
          endTime = startTime + 1;
        } else if (startTime - 1 >= 0) {
          startTime = endTime - 1;
        } else {
          return { ...segment, segmentSummary: '' };
        }
      }

      const maxCutDuration = segment.duration + 5;
      if (endTime - startTime > maxCutDuration) {
        endTime = startTime + maxCutDuration;
      }

      const segmentVideoPath = `temporary-files/segment-${segment.index}-${crypto.randomUUID()}.mp4`;

      try {
        await VideoUtils.cutVideo({
          inputFilePath: videoPath,
          startTime: Math.floor(startTime),
          endTime: Math.ceil(endTime),
          outputFilePath: segmentVideoPath,
        });

        const segmentSummary = await geminiService.requestToGemini({
          prompt,
          model: geminiModels.gemini2_5flash_lite,
          temperature: 0.2,
          filePath: segmentVideoPath,
          timeoutInMs: 60000,
        });

        console.info(`Summary for segment ${segment.index}: `, segmentSummary);

        return { ...segment, segmentSummary };
      } catch (error) {
        console.error(`Failed to analyze segment ${segment.index}:`, error);
        return { ...segment, segmentSummary: '' };
      } finally {
        await safeUnlink(segmentVideoPath);
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        const index = batchResults.indexOf(result);
        if (batch[index]) {
          results.push({ ...batch[index], segmentSummary: '' });
        }
      }
    }
  }

  results.sort((a, b) => a.index - b.index);

  console.debug('Segment visual context analysis completed');
  return results;
}

/**
 * Detect if a face with visible mouth is present in a video segment
 * Used by SmartSync to determine timestamp extension limits
 */
export async function detectFaceInVideoSegment(
  videoPath: string,
  startTime: number,
  endTime: number,
  geminiService: GeminiService,
): Promise<boolean> {
  // Ensure valid time range
  const safeStart = Math.max(0, Number(startTime.toFixed(2)));
  const minWindow = 0.1;
  const safeEnd = endTime <= safeStart ? safeStart + minWindow : Number(endTime.toFixed(2));

  const segmentPath = `temporary-files/face-check-${crypto.randomUUID()}.mp4`;

  try {
    await VideoUtils.cutVideo({
      inputFilePath: videoPath,
      startTime: safeStart,
      endTime: safeEnd,
      outputFilePath: segmentPath,
    });

    const prompt = PromptBuilder.createPromptToDetectFaceInVideo();

    const response = await geminiService.requestToGemini({
      prompt,
      model: geminiModels.gemini2_5flash,
      temperature: 0.5,
      filePath: segmentPath,
      timeoutInMs: 30000,
    });

    const trimmed = response.trim().toLowerCase();
    return trimmed === 'true';
  } catch (error) {
    console.error('Error detecting face in video segment:', error);
    return true;
  } finally {
    await safeUnlink(segmentPath);
  }
}
