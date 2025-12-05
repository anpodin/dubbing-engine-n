import { spawn } from 'child_process';
import * as ffprobeStatic from 'ffprobe-static';

export interface FFmpegResult {
  stdout: string;
  stderr: string;
}

export interface FFprobeFormat {
  duration?: number;
  format_name?: string;
  size?: string;
  bit_rate?: string;
}

export interface FFprobeStream {
  index: number;
  codec_name?: string;
  codec_type?: 'video' | 'audio' | 'subtitle' | 'data';
  pix_fmt?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
}

export interface FFprobeMetadata {
  format: FFprobeFormat;
  streams: FFprobeStream[];
}

const DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes

/**
 * Execute FFmpeg with the given arguments
 * @param args - Array of FFmpeg command-line arguments (without 'ffmpeg')
 * @param options - Optional configuration
 * @returns Promise with stdout and stderr
 */
export async function runFFmpeg(
  args: string[],
  options?: { timeout?: number },
): Promise<FFmpegResult> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;

  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timeoutId = setTimeout(() => {
      killed = true;
      process.kill('SIGTERM');
      reject(new Error(`FFmpeg process timed out after ${timeout}ms`));
    }, timeout);

    process.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    process.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`FFmpeg failed to start: ${err.message}`));
    });

    process.on('close', (code) => {
      clearTimeout(timeoutId);

      if (killed) return;

      if (code !== 0) {
        const errorMessage = parseFFmpegError(stderr) || `FFmpeg exited with code ${code}`;
        reject(new Error(errorMessage));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Execute FFprobe and return parsed metadata
 * @param filePath - Path to the media file
 * @returns Promise with parsed FFprobe metadata
 */
export async function runFFprobe(filePath: string): Promise<FFprobeMetadata> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];

    const process = spawn(ffprobeStatic.path, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    process.on('error', (err) => {
      reject(new Error(`FFprobe failed to start: ${err.message}`));
    });

    process.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFprobe failed: ${stderr || `exit code ${code}`}`));
        return;
      }

      try {
        const rawMetadata = JSON.parse(stdout);

        // ffprobe returns duration as a string, convert to number
        const metadata: FFprobeMetadata = {
          format: {
            ...rawMetadata.format,
            duration: rawMetadata.format?.duration
              ? parseFloat(rawMetadata.format.duration)
              : undefined,
          },
          streams: rawMetadata.streams || [],
        };

        resolve(metadata);
      } catch (parseError) {
        reject(new Error(`Failed to parse FFprobe output: ${stdout}`));
      }
    });
  });
}

/**
 * Get audio codec from a media file
 * @param filePath - Path to the media file
 * @returns Audio codec name or null if not found
 */
export async function getAudioCodecFromFile(filePath: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ];

    const process = spawn(ffprobeStatic.path, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';

    process.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.on('error', (err) => {
      console.error('Error running ffprobe:', err);
      resolve(null);
    });

    process.on('close', (code) => {
      if (code !== 0) {
        console.error('FFprobe exited with code:', code);
        resolve(null);
        return;
      }

      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      // Look for the line "audio" then the next line should be the codec
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === 'audio' && lines[i + 1]) {
          resolve(lines[i + 1]);
          return;
        }
      }

      resolve(null);
    });
  });
}

/**
 * Parse FFmpeg error messages for common issues
 */
function parseFFmpegError(stderr: string): string | null {
  const lowerStderr = stderr.toLowerCase();

  if (lowerStderr.includes('invalid data found when processing input')) {
    return 'POSSIBLY_CORRUPTED_FILE: Invalid data found when processing input';
  }
  if (lowerStderr.includes('prediction is not allowed in aac-lc')) {
    return 'POSSIBLY_CORRUPTED_FILE: Prediction is not allowed in AAC-LC';
  }
  if (lowerStderr.includes('reserved bit set')) {
    return 'POSSIBLY_CORRUPTED_FILE: Reserved bit set';
  }
  if (lowerStderr.includes('corrupt')) {
    return 'POSSIBLY_CORRUPTED_FILE: File appears to be corrupt';
  }
  if (lowerStderr.includes('no such file or directory')) {
    return 'File not found';
  }
  if (lowerStderr.includes('permission denied')) {
    return 'Permission denied';
  }

  // Return last meaningful error line
  const errorLines = stderr
    .split('\n')
    .filter((line) => line.toLowerCase().includes('error'))
    .map((line) => line.trim());

  return errorLines.length > 0 ? errorLines[errorLines.length - 1] : null;
}

/**
 * Check if FFmpeg error indicates a corrupted file
 */
export function isCorruptedFileError(error: Error): boolean {
  return error.message.startsWith('POSSIBLY_CORRUPTED_FILE:');
}
