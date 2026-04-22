import path from 'path';
import crypto from 'crypto';
import { pathExists, safeUnlink } from '../utils/fsUtils';
import { runFFmpeg, runFFprobe } from './ffmpeg-runner';

export class VideoUtils {
  static async getFileDuration(filePath: string): Promise<number | 'N/A'> {
    if (!filePath) {
      console.error('No file path provided');
      throw new Error('No file path provided');
    }

    try {
      if (!(await pathExists(filePath))) {
        console.error(`File not found: ${filePath}`);
        throw new Error('File not found or inaccessible');
      }
    } catch (error) {
      console.error('Error checking file access:', error);
      throw new Error('File not found or inaccessible');
    }

    try {
      const metadata = await runFFprobe(filePath);

      if (!metadata?.format?.duration) {
        console.error('No duration found in metadata:', {
          filePath,
          metadata: metadata?.format,
        });
        throw new Error('Could not determine media duration');
      }

      const duration = metadata.format.duration;
      if (typeof duration !== 'number' || isNaN(duration) || duration <= 0) {
        console.error('Invalid duration value:', duration);
        console.error('metadata of the file:', metadata);
      }

      return duration;
    } catch (err) {
      console.error('Error while getting file duration:', err);

      const errorMessage = (err as Error).message?.toLowerCase() || '';
      if (errorMessage.includes('invalid data') || errorMessage.includes('unsupported format')) {
        throw new Error('Invalid or unsupported media format');
      }
      if (errorMessage.includes('permission denied')) {
        throw new Error('Permission denied to access file');
      }

      throw new Error('Failed to process media file');
    }
  }

  static async getAudioMergeWithVideo(videoPath: string, audioPath: string): Promise<string> {
    console.debug('Merging audio and video...');
    let filePath = '';
    let stretchedVideoPath: string | null = null;
    try {
      const outputPath = path.join(`output/result-${crypto.randomUUID()}.mp4`);
      const audioDuration = await this.getFileDuration(audioPath);
      const videoDuration = await this.getFileDuration(videoPath);

      if (typeof audioDuration !== 'number')
        throw new Error(
          `Error during audio duration when merging audio and video: duration is not a number: ${audioDuration}`,
        );
      if (typeof videoDuration !== 'number')
        throw new Error(
          `Error during video duration when merging audio and video: duration is not a number: ${videoDuration}`,
        );

      const maxDriftWithoutStretch = 0.15;
      let videoPathToMerge = videoPath;

      if (audioDuration - videoDuration > maxDriftWithoutStretch) {
        const slowdownFactor = Number((audioDuration / videoDuration).toFixed(4));
        stretchedVideoPath = await this.stretchVideoDuration({
          videoPath,
          slowdownFactor,
        });
        videoPathToMerge = stretchedVideoPath;
      }

      filePath = await this.mergeAudioAndVideo({
        videoPath: videoPathToMerge,
        audioPath,
        outputPath,
      });

      console.debug('Audio and video merged.');

      return filePath;
    } catch (e) {
      console.error(e);
      throw new Error('Error while merging audio and video');
    } finally {
      if (stretchedVideoPath) {
        await safeUnlink(stretchedVideoPath);
      }
    }
  }

  static async stretchVideoDuration({
    videoPath,
    slowdownFactor,
  }: {
    videoPath: string;
    slowdownFactor: number;
  }): Promise<string> {
    const outputPath = `temporary-files/stretched-video-${crypto.randomUUID()}.mp4`;

    const args = [
      '-i',
      videoPath,
      '-vf',
      `setpts=${slowdownFactor}*PTS`,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-y',
      outputPath,
    ];

    await runFFmpeg(args);
    return outputPath;
  }

  static mergeAudioAndVideo = async ({
    videoPath,
    audioPath,
    outputPath,
  }: {
    videoPath: string;
    audioPath: string;
    outputPath: string;
  }): Promise<string> => {
    console.debug('Merging audio and video...');

    const fileExtension = path.extname(videoPath).substring(1).toLowerCase();

    // Get metadata for both files
    const audioMetadata = await runFFprobe(audioPath);
    const audioStreamIndex = audioMetadata.streams.findIndex((stream) => stream.codec_type === 'audio');
    if (audioStreamIndex === -1) {
      throw new Error('No valid audio track found in the provided audio file');
    }

    const videoMetadata = await runFFprobe(videoPath);
    const videoStreamIndex = videoMetadata.streams.findIndex((stream) => stream.codec_type === 'video');

    if (videoStreamIndex === -1) {
      throw new Error('No valid video track found in the provided video file');
    }

    const isAAC = audioMetadata.streams.some(
      (stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac',
    );

    const args = [
      '-i',
      videoPath,
      '-i',
      audioPath,
      '-map',
      `0:${videoStreamIndex}`,
      '-map',
      `1:${audioStreamIndex}`,
      '-c:v',
      'copy',
      isAAC ? '-c:a' : '-c:a',
      isAAC ? 'copy' : 'aac',
      '-b:a',
      '320k',
      '-ar',
      '48000',
      '-movflags',
      '+faststart',
      '-threads',
      '0',
      '-f',
      fileExtension,
      '-y',
      outputPath,
    ];

    try {
      await runFFmpeg(args);
      console.debug('Merging succeeded with minimal re-encoding.');
      return outputPath;
    } catch (err) {
      console.error('Error merging audio/video:', err);
      throw err;
    }
  };

  static addSubtitles = async ({
    videoPath,
    srtFilePath,
    outputFilePath,
  }: {
    videoPath: string;
    srtFilePath: string;
    outputFilePath: string;
  }) => {
    if (!(await pathExists(srtFilePath))) {
      throw new Error('Srt file does not exist');
    }

    // Get video metadata
    const metadata = await runFFprobe(videoPath);

    // Check if we're dealing with an HEVC/H.265 video
    const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video');
    const isHEVC =
      videoStream && videoStream.codec_name && videoStream.codec_name.toLowerCase().includes('hevc');
    const is10bit = videoStream && videoStream.pix_fmt && videoStream.pix_fmt.includes('10le');

    console.debug(
      `Video info: codec=${videoStream?.codec_name}, pixel format=${videoStream?.pix_fmt}, isHEVC=${isHEVC}, is10bit=${is10bit}`,
    );

    // Add subtitles filter with compatible font
    const subtitlesFilter = `subtitles=${srtFilePath}:force_style='FontName=DejaVu'`;

    let args: string[];

    if (isHEVC || is10bit) {
      // For HEVC/10-bit videos that need browser compatibility:
      console.debug('Converting HEVC/10-bit video to browser-compatible format');
      args = [
        '-i',
        videoPath,
        '-c:v',
        'libx264',
        '-vf',
        subtitlesFilter,
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '18',
        '-preset',
        'medium',
        '-movflags',
        '+faststart',
        '-c:a',
        'aac',
        '-b:a',
        '320k',
        '-y',
        outputFilePath,
      ];
    } else {
      // For already compatible videos, minimal processing
      args = [
        '-i',
        videoPath,
        '-c:v',
        'libx264',
        '-vf',
        subtitlesFilter,
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
        '-y',
        outputFilePath,
      ];
    }

    try {
      await runFFmpeg(args);
      console.debug('Subtitles added successfully');
      return outputFilePath;
    } catch (err) {
      console.error('Error adding subtitles:', err);
      throw err;
    }
  };

  /**
   * Get video orientation based on width vs height
   */
  static async getVideoOrientation(
    videoPath: string,
  ): Promise<{ orientation: 'vertical' | 'horizontal' | 'square'; width: number; height: number }> {
    if (!(await pathExists(videoPath))) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    const metadata = await runFFprobe(videoPath);
    const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video');

    if (!videoStream) {
      throw new Error('No video stream found in file');
    }

    const width = videoStream.width || 0;
    const height = videoStream.height || 0;

    if (width === 0 || height === 0) {
      throw new Error('Could not determine video dimensions');
    }

    let orientation: 'vertical' | 'horizontal' | 'square';
    if (height > width) {
      orientation = 'vertical';
    } else if (width > height) {
      orientation = 'horizontal';
    } else {
      orientation = 'square';
    }

    console.debug(`Video orientation: ${orientation} (${width}x${height})`);
    return { orientation, width, height };
  }

  /**
   * Cut a portion of a video file between startTime and endTime
   * Used for video analysis (chunking long videos, segment extraction)
   */
  static async cutVideo({
    inputFilePath,
    startTime,
    endTime,
    outputFilePath,
  }: {
    inputFilePath: string;
    startTime: number;
    endTime: number;
    outputFilePath: string;
  }): Promise<string> {
    if (!(await pathExists(inputFilePath))) {
      throw new Error(`Input file not found: ${inputFilePath}`);
    }

    if (startTime < 0) {
      startTime = 0;
    }

    if (endTime <= startTime) {
      throw new Error(
        `Invalid time range: endTime (${endTime}) must be greater than startTime (${startTime})`,
      );
    }

    const duration = endTime - startTime;

    // Use -ss before -i for fast seeking, then -t for duration
    // Copy streams without re-encoding for speed
    const args = [
      '-ss',
      startTime.toString(),
      '-i',
      inputFilePath,
      '-t',
      duration.toString(),
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      '-y',
      outputFilePath,
    ];

    try {
      await runFFmpeg(args);
      console.debug(`Video cut: ${startTime}s - ${endTime}s -> ${outputFilePath}`);
      return outputFilePath;
    } catch (err) {
      console.error('Error cutting video:', err);
      throw new Error(`Failed to cut video segment: ${(err as Error).message}`);
    }
  }
}
