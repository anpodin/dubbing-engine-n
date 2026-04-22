import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import crypto from 'crypto';
import { Readable } from 'stream';
import { file as fileTMP } from 'tmp-promise';
import path from 'path';
import { VideoUtils } from './video-utils';
import { ensureDir, pathExists, safeUnlink } from '../utils/fsUtils';
import { runFFmpeg, getAudioCodecFromFile, isCorruptedFileError } from './ffmpeg-runner';

export class AudioUtils {
  static async getAudioCodec(inputFile: string): Promise<string | null> {
    return getAudioCodecFromFile(inputFile);
  }

  static async separateAudioAndVideo(inputPath: string): Promise<{ audioPath: string; videoPath: string }> {
    if (!(await pathExists(inputPath))) throw new Error(`File not found: ${inputPath}`);
    console.debug(`Separating audio and video...`);

    const audioOutputPathNoExtension = `temporary-files/audio-${crypto.randomUUID()}`;
    const videoOutputPath = `temporary-files/video-${crypto.randomUUID()}.mp4`;

    let audioCodec: string | null = null;
    let finalAudioPath = '';

    try {
      // 1) Determine audio codec
      audioCodec = await this.getAudioCodec(inputPath);

      // Decide the container and whether we can copy the stream:
      // --------------------------------------------------------
      // For AAC -> use .m4a container, copy stream
      // For MP3 -> use .mp3 container, copy stream
      // Otherwise -> re-encode to WAV (.wav)
      let audioContainer = 'm4a';
      let copyAudio = false;

      if (audioCodec && /aac/i.test(audioCodec)) {
        audioContainer = 'm4a';
        copyAudio = true;
      } else if (audioCodec && /mp3/i.test(audioCodec)) {
        audioContainer = 'mp3';
        copyAudio = true;
      } else {
        audioContainer = 'wav';
        copyAudio = false;
      }

      finalAudioPath = `${audioOutputPathNoExtension}.${audioContainer}`;

      // Extract audio
      const audioArgs = ['-i', inputPath, '-vn'];
      if (copyAudio) {
        audioArgs.push('-c:a', 'copy');
      } else {
        audioArgs.push('-c:a', 'pcm_s16le', '-ar', '44100');
      }
      audioArgs.push('-y', finalAudioPath);

      try {
        await runFFmpeg(audioArgs);
        console.debug('Audio extraction done.');
      } catch (err) {
        console.error('Audio extraction error:', err);
        throw new Error(`ffmpeg audio error: ${(err as Error).message}`);
      }

      // Extract video
      const videoArgs = ['-i', inputPath, '-an', '-c:v', 'copy', '-y', videoOutputPath];

      try {
        await runFFmpeg(videoArgs);
        console.debug('Video extraction done.');
      } catch (err) {
        console.error('Video extraction error:', err);
        throw new Error(`ffmpeg video error: ${(err as Error).message}`);
      }

      console.debug('Audio and video separated successfully.');
      return {
        audioPath: finalAudioPath,
        videoPath: videoOutputPath,
      };
    } catch (error) {
      console.error('Error in separateAudioAndVideo:', error);

      // Cleanup
      if (finalAudioPath) await safeUnlink(finalAudioPath);
      if (videoOutputPath) await safeUnlink(videoOutputPath);

      if (isCorruptedFileError(error as Error)) {
        throw error;
      }

      const errMsg = (error as Error).message || '';
      if (
        errMsg.includes('Invalid data found when processing input') ||
        errMsg.includes('Prediction is not allowed in AAC-LC') ||
        errMsg.includes('Reserved bit set.') ||
        errMsg.includes('corrupt')
      ) {
        throw new Error(`POSSIBLY_CORRUPTED_FILE: ${errMsg}`);
      }
      throw error;
    }
  }

  static async convertToMp3(inputFilePath: string, outputFilePath: string): Promise<void> {
    console.debug('Converting audio to mp3...');

    const args = ['-i', inputFilePath, '-c:a', 'libmp3lame', '-b:a', '320k', '-y', outputFilePath];

    try {
      await runFFmpeg(args);
      console.debug('Audio converted to mp3.');
      console.debug('Conversion completed.');
    } catch (err) {
      console.error('Error while converting audio to mp3:', err);
      throw err;
    }
  }

  static async trimAudioBuffer(audioBuffer: Buffer, durationInSeconds: number): Promise<Buffer> {
    const { path: inputPath, cleanup: cleanupInput } = await fileTMP({ postfix: '.mp3' });
    const { path: outputPath, cleanup: cleanupOutput } = await fileTMP({ postfix: '.mp3' });

    try {
      await fsPromises.writeFile(inputPath, audioBuffer);

      const args = [
        '-i',
        inputPath,
        '-t',
        durationInSeconds.toString(),
        '-c:a',
        'libmp3lame',
        '-b:a',
        '320k',
        '-y',
        outputPath,
      ];

      await runFFmpeg(args);
      const resultBuffer = await fsPromises.readFile(outputPath);
      return resultBuffer;
    } catch (err) {
      console.error('Error while trimming audio buffer:', err);
      throw err;
    } finally {
      await cleanupInput();
      await cleanupOutput();
    }
  }

  static async convertPCMBufferToWav(pcmBuffer: Buffer): Promise<Buffer> {
    const { path: pcmFilePath, cleanup: pcmCleanup } = await fileTMP({
      postfix: '.pcm',
    });
    const { path: wavFilePath, cleanup: wavCleanup } = await fileTMP({
      postfix: '.wav',
    });

    try {
      await fsPromises.writeFile(pcmFilePath, pcmBuffer);
      console.debug('Converting PCM buffer to WAV file using ffmpeg');

      const args = ['-f', 's16le', '-ar', '44100', '-ac', '1', '-i', pcmFilePath, '-y', wavFilePath];

      await runFFmpeg(args);
      const wavBuffer = await fsPromises.readFile(wavFilePath);
      return wavBuffer;
    } catch (error) {
      console.error('Failed to convert PCM buffer to WAV:', error);
      throw new Error('Failed to convert PCM buffer to WAV');
    } finally {
      if (await pathExists(pcmFilePath)) await pcmCleanup();
      if (await pathExists(wavFilePath)) await wavCleanup();
    }
  }

  static async getAverageDecibel(inputFilePath: string): Promise<number> {
    console.debug(`Analyzing audio decibel level for: ${inputFilePath}`);

    if (!(await pathExists(inputFilePath))) {
      throw new Error(`File not found: ${inputFilePath}`);
    }

    const args = ['-i', inputFilePath, '-af', 'volumedetect', '-f', 'null', '-y', '/dev/null'];

    try {
      const { stderr } = await runFFmpeg(args);

      // Extract the mean_volume value from stderr
      const match = stderr.match(/mean_volume: ([-\d.]+) dB/);
      if (match && match[1]) {
        const averageDecibel = parseFloat(match[1]);
        console.debug(`Average decibel level: ${averageDecibel} dB`);
        return averageDecibel;
      } else {
        throw new Error('Failed to extract mean volume information');
      }
    } catch (err) {
      console.error('Error analyzing audio volume:', err);
      throw err;
    }
  }

  // -------------------------
  // adjustAudioToDecibel - Adjust audio volume to reach target decibel level
  // -------------------------
  static async adjustAudioToDecibel(inputFilePath: string, targetDecibel: number): Promise<string> {
    console.debug(`Adjusting audio to target decibel level: ${targetDecibel} dB`);

    if (!(await pathExists(inputFilePath))) {
      throw new Error(`File not found: ${inputFilePath}`);
    }

    // Get current average decibel level
    const currentDecibel = await this.getAverageDecibel(inputFilePath);

    // Calculate the gain needed (difference between target and current)
    // Audio decibels are often negative values, so this calculation works for both positive and negative values
    const gainNeeded = Number((targetDecibel - currentDecibel).toFixed(2));

    const fileExtension = path.extname(inputFilePath);
    const tempOutputFilePath = `temporary-files/adjusted-audio-${crypto.randomUUID()}${fileExtension}`;

    const outputDir = path.dirname(tempOutputFilePath);
    await ensureDir(outputDir);

    const volumeFilter = `volume=${gainNeeded}dB`;
    console.debug(`Applying volume filter: ${volumeFilter}`);

    const args = ['-i', inputFilePath, '-af', volumeFilter, '-y', tempOutputFilePath];

    try {
      await runFFmpeg(args);
      console.debug(`Audio adjusted to target level and saved to: ${tempOutputFilePath}`);

      await fsPromises.unlink(inputFilePath);
      console.debug(`Original file deleted: ${inputFilePath}`);

      await fsPromises.rename(tempOutputFilePath, inputFilePath);
      console.debug(`Adjusted file moved to original location: ${inputFilePath}`);

      return inputFilePath;
    } catch (err) {
      console.error('Error adjusting audio volume:', err);
      throw err;
    }
  }

  static async cutAudioToBufferAtSpecificTime(
    audioPath: string,
    start: number,
    end: number,
    returnBuffer: boolean = true,
  ): Promise<Buffer | string> {
    console.debug('Cutting audio to buffer at specific time...');
    const { path: tempFilePath, cleanup } = await fileTMP({
      postfix: '.mp3',
      keep: !returnBuffer,
    });

    const duration = end - start;
    const args = [
      '-i',
      audioPath,
      '-ss',
      start.toString(),
      '-t',
      duration.toString(),
      '-c:a',
      'libmp3lame',
      '-b:a',
      '320k',
      '-y',
      tempFilePath,
    ];

    try {
      await runFFmpeg(args);

      if (returnBuffer) {
        const buffer = await fsPromises.readFile(tempFilePath);
        await cleanup();
        console.debug('Audio cut to buffer at specific time successfully.');
        return buffer;
      } else {
        return tempFilePath;
      }
    } catch (err) {
      await cleanup();
      throw err;
    }
  }

  static async concatenateAudio({
    files,
    outputPath,
    outputFormat = 'wav',
  }: {
    files: string[];
    outputPath: string;
    outputFormat?: 'wav' | 'mp3';
  }): Promise<string> {
    const outputDir = path.dirname(outputPath);
    await ensureDir(outputDir);

    const validFiles: string[] = [];

    // Validate files
    for (const file of files) {
      if (!(await pathExists(file))) {
        console.error(`\n[SKIP FILE] File does not exist: ${file}\n`);
        continue;
      }

      try {
        // Verify file is valid by attempting to process it
        await runFFmpeg(['-i', file, '-f', 'null', '-y', '/dev/null']);
        validFiles.push(file);
      } catch (err) {
        console.error(`\n[SKIP FILE] Invalid/unreadable audio file: ${file}`);
        console.error('Reason:', err, '\n');
      }
    }

    if (validFiles.length === 0) {
      console.error('\n[CONCAT WARNING] No valid audio files found. Skipping concatenation.\n');
      return outputPath;
    }

    const randomId = crypto.randomBytes(8).toString('hex');
    const concatFilePath = path.join(outputDir, `concat_${randomId}.txt`);

    const fileContent = validFiles.map((filePath) => `file '${path.resolve(filePath)}'`).join('\n');
    fs.writeFileSync(concatFilePath, fileContent);

    try {
      console.debug('Starting audio concatenation...');
      console.debug('Processing audio files...');

      const args = ['-f', 'concat', '-safe', '0', '-i', concatFilePath];

      if (outputFormat === 'wav') {
        args.push('-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', '-f', 'wav');
      } else if (outputFormat === 'mp3') {
        args.push('-c:a', 'libmp3lame', '-ar', '44100', '-ac', '1', '-b:a', '320k', '-f', 'mp3');
      }

      args.push('-loglevel', 'error', '-y', outputPath);

      await runFFmpeg(args);
      console.debug('Audio concatenation completed successfully.');
    } catch (err) {
      throw new Error(`Concatenation failed: ${(err as Error).message}`);
    } finally {
      await safeUnlink(concatFilePath);

      for (const file of files) {
        await safeUnlink(file);
      }
    }

    return outputPath;
  }

  static async duplicateAndConcatenateAudio(
    inputFilePath: string,
    repeatCount: number,
    outputFormat: 'wav' | 'mp3' = 'wav',
  ): Promise<string> {
    console.debug(`Duplicating and concatenating audio ${repeatCount} times...`);

    if (!(await pathExists(inputFilePath))) {
      throw new Error('Input file does not exist');
    }

    const tempDir = 'temporary-files/temp';
    const inputTempDir = 'temporary-files';
    const outputDir = 'temporary-files';
    const tempFilePaths: string[] = [];
    let concatFilePath: string | null = null;
    let outputFilePath: string | null = null;

    try {
      await Promise.all([tempDir, inputTempDir, outputDir].map((dir) => ensureDir(dir)));

      const inputExtension = path.extname(inputFilePath) || (outputFormat === 'wav' ? '.wav' : '.mp3');

      for (let i = 0; i < repeatCount; i++) {
        const tempFilePath = path.join(
          inputTempDir,
          `for-duplicate-audio-${crypto.randomUUID()}${inputExtension}`,
        );
        await fs.promises.copyFile(inputFilePath, tempFilePath);
        tempFilePaths.push(tempFilePath);
      }

      concatFilePath = path.join(tempDir, `concat-${crypto.randomUUID()}.txt`);
      console.debug('Concat file path:', concatFilePath);
      const concatContent = tempFilePaths.map((file) => `file '${path.relative(tempDir, file)}'`).join('\n');
      await fs.promises.writeFile(concatFilePath, concatContent);

      const outputExtension = outputFormat === 'wav' ? '.wav' : '.mp3';
      outputFilePath = path.join(outputDir, `${crypto.randomUUID()}${outputExtension}`);

      console.debug('Processing audio files...');

      const args = ['-f', 'concat', '-safe', '0', '-i', concatFilePath];

      if (outputFormat === 'wav') {
        args.push('-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', '-f', 'wav');
      } else if (outputFormat === 'mp3') {
        args.push('-c:a', 'libmp3lame', '-ar', '44100', '-ac', '1', '-b:a', '320k', '-f', 'mp3');
      }

      args.push('-loglevel', 'error', '-y', outputFilePath);

      await runFFmpeg(args);
      console.debug('Audio duplication and concatenation completed.');

      return outputFilePath;
    } catch (error) {
      console.error('An error occurred:', error);
      throw error;
    } finally {
      const filesToDelete = [...tempFilePaths, concatFilePath, inputFilePath].filter(
        (file): file is string => file !== null,
      );

      await Promise.all(filesToDelete.map((file) => safeUnlink(file)));

      if (outputFilePath && !(await pathExists(outputFilePath))) {
        console.error('Output file was not created successfully.');
      }
    }
  }

  static async getAudioDurationFromBuffer(
    buffer: Buffer | Readable | NodeJS.ReadableStream,
  ): Promise<number | 'N/A'> {
    const uuid = crypto.randomUUID();
    const tempFileName = `temporary-files/output-${uuid}-for-getting-audio-duration.wav`;

    try {
      // Add type checking
      if (typeof buffer === 'number' || !buffer) {
        console.error('Invalid input: buffer must be a Buffer or Readable stream');
        throw new Error('Invalid input: buffer must be a Buffer or Readable stream');
      }

      await fsPromises.writeFile(tempFileName, buffer);

      // Use the common utility for getting file duration
      const duration = await VideoUtils.getFileDuration(tempFileName);

      return duration;
    } catch (error) {
      console.error('Failed to get audio duration from buffer:', error);
      throw new Error('Failed to get audio duration');
    } finally {
      try {
        await safeUnlink(tempFileName);
      } catch (unlinkError) {
        console.error(`Error deleting temporary file: ${tempFileName}`, unlinkError);
      }
    }
  }

  static async removeStartAndEndSilenceFromAudioWithFFMPEG(inputFilePath: string, outputFilePath: string) {
    // Remove silence from the audio file at the beginning and at the end only
    const silenceFilter =
      'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-400dB,' +
      'silenceremove=stop_periods=-1:stop_duration=0.1:stop_threshold=-400dB';

    const args = ['-i', inputFilePath, '-af', silenceFilter, '-y', outputFilePath];

    try {
      await runFFmpeg(args);
    } catch (err) {
      console.error('Error:', (err as Error).message);
      throw err;
    }
  }

  static async adjustSpeed(speech: Buffer, speedFactor: number): Promise<Buffer> {
    console.debug('Adjusting audio speed with factor:', speedFactor);

    // Use temp files instead of streams to avoid blocking issues
    const { path: inputPath, cleanup: cleanupInput } = await fileTMP({ postfix: '.wav' });
    const { path: outputPath, cleanup: cleanupOutput } = await fileTMP({ postfix: '.wav' });

    try {
      await fsPromises.writeFile(inputPath, speech);

      const args = [
        '-i',
        inputPath,
        '-c:a',
        'pcm_s16le',
        '-af',
        `atempo=${speedFactor}`,
        '-f',
        'wav',
        '-y',
        outputPath,
      ];

      await runFFmpeg(args);
      console.debug('Speed adjustment completed');

      const resultBuffer = await fsPromises.readFile(outputPath);
      return resultBuffer;
    } catch (error) {
      console.error('Failed to adjust audio speed:', error);
      throw error;
    } finally {
      await cleanupInput();
      await cleanupOutput();
    }
  }

  static async adjustPitch(speech: Buffer, semitones: number): Promise<Buffer> {
    if (!Number.isFinite(semitones) || semitones === 0) {
      return speech;
    }

    const pitchFactor = Math.pow(2, semitones / 12);

    if (pitchFactor <= 0) {
      throw new Error(`Invalid pitch factor calculated from semitones: ${semitones}`);
    }

    const tempoCompensation = 1 / pitchFactor;

    if (tempoCompensation < 0.5 || tempoCompensation > 2.0) {
      throw new Error(
        `Pitch adjustment out of supported FFmpeg atempo range. semitones=${semitones}, atempo=${tempoCompensation.toFixed(3)}`,
      );
    }

    const { path: inputPath, cleanup: cleanupInput } = await fileTMP({ postfix: '.wav' });
    const { path: outputPath, cleanup: cleanupOutput } = await fileTMP({ postfix: '.wav' });

    try {
      await fsPromises.writeFile(inputPath, speech);

      const pitchFilter = `aresample=44100,asetrate=44100*${pitchFactor},aresample=44100,atempo=${tempoCompensation}`;
      const args = ['-i', inputPath, '-af', pitchFilter, '-c:a', 'pcm_s16le', '-f', 'wav', '-y', outputPath];

      await runFFmpeg(args);
      return await fsPromises.readFile(outputPath);
    } finally {
      await cleanupInput();
      await cleanupOutput();
    }
  }

  static async generateSilence(duration: number, audioFrequency: number): Promise<string> {
    const { path: outputPath } = await fileTMP({ postfix: '.wav' });

    if (duration <= 0.001) {
      throw new Error(`Silence duration is too short, must be greater than 0: ${duration}`);
    }

    const args = [
      '-f',
      'lavfi',
      '-i',
      `anullsrc=channel_layout=mono:sample_rate=${audioFrequency}`,
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      '-t',
      duration.toString(),
      '-y',
      outputPath,
    ];

    try {
      await runFFmpeg(args);
    } catch (err) {
      console.error(err);
      throw err;
    }

    return outputPath;
  }

  static overlayingAudio = async (outputPath: string, files: string[]): Promise<string> => {
    if (files.length === 0) {
      throw new Error('No audio files provided.');
    }

    // If there is only one file, just copy it without mixing
    if (files.length === 1) {
      await fsPromises.copyFile(files[0], outputPath);
      return outputPath;
    }

    console.debug('Starting audio overlaying...');
    console.debug('FFmpeg started processing...');

    // Build complex filter
    const filters: string[] = [];
    let amixInputs = '';

    files.forEach((_, index) => {
      filters.push(`[${index}:a]aresample=44100,aformat=channel_layouts=stereo[a${index}]`);
      amixInputs += `[a${index}]`;
    });

    filters.push(`${amixInputs}amix=inputs=${files.length}:duration=longest:dropout_transition=1[aout]`);
    const filterComplex = filters.join(';');

    // Build args with all inputs
    const args: string[] = [];
    files.forEach((file) => {
      args.push('-i', file);
    });
    args.push(
      '-filter_complex',
      filterComplex,
      '-map',
      '[aout]',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      '-y',
      outputPath,
    );

    try {
      await runFFmpeg(args);
      console.debug('Audio files have been merged successfully.');
      // Cleanup temporary files
      for (const file of files) {
        await safeUnlink(file);
      }
      console.debug('Audio overlaying done.');
      return outputPath;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      for (const file of files) {
        await safeUnlink(file);
      }
      throw err;
    }
  };

  static async startEqualizeAudio(audioPath: string): Promise<string> {
    const uuid = crypto.randomUUID();
    const newAudioPath = `temporary-files/${uuid}-equalized.wav`;

    try {
      await this.equalizeAudio(audioPath, newAudioPath, 44100);
      return newAudioPath;
    } catch (err) {
      console.error(err);
      throw new Error('Error while equalizing audio');
    } finally {
      await safeUnlink(audioPath);
    }
  }

  static async equalizeAudio(
    inputFilePath: string,
    outputFilePath: string,
    audioFrequency: number,
  ): Promise<void> {
    console.debug('Equalizing audio...');

    const loudnormFilter =
      'loudnorm=I=-23:LRA=7:TP=-2:measured_I=-24:measured_LRA=11:measured_TP=-1.5:measured_thresh=-25.6:offset=-0.7';

    const args = [
      '-i',
      inputFilePath,
      '-c:a',
      'pcm_s16le',
      '-ar',
      audioFrequency.toString(),
      '-af',
      loudnormFilter,
      '-y',
      outputFilePath,
    ];

    try {
      await runFFmpeg(args);
      console.debug('Audio equalization completed.');
    } catch (err) {
      console.error('Error while equalizing audio:', err);
      throw err;
    }
  }

  static async mergeAudioFiles(audioPath1: string, audioPath2: string, outputPath: string): Promise<string> {
    const args = [
      '-i',
      audioPath1,
      '-i',
      audioPath2,
      '-filter_complex',
      'amix=inputs=2:duration=longest',
      '-c:a',
      'pcm_s16le',
      '-y',
      outputPath,
    ];

    try {
      await runFFmpeg(args);
      console.debug('Merging audio and background music done.');
      return outputPath;
    } catch (err) {
      console.error(err);
      throw err;
    }
  }
}
