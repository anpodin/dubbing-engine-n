import crypto from 'crypto';
import { spawn } from 'child_process';
import fsPromises from 'fs/promises';
import path from 'path';
import type {
  SpeechmaticsFormattedResponse,
  SpeechmaticsResult,
  SpeechmaticsSegment,
  SpeechmaticsTranscriptionResponse,
  SpeechmaticsWord,
} from '../types/speechmatics';
import { ensureDir, pathExists } from '../utils/fsUtils';

type WhisperCliTranscriptionItem = {
  offsets?: {
    from?: number;
    to?: number;
  };
  text?: string;
};

type WhisperCliJson = {
  result?: {
    language?: string;
  };
  transcription?: WhisperCliTranscriptionItem[];
};

type CmdResult = { stdout: string; stderr: string };

function execCmd(command: string, args: string[], cwd: string): Promise<CmdResult> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    process.on('error', (err) => {
      reject(err);
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || `Command failed: ${command} ${args.join(' ')} (exit code ${code})`));
    });
  });
}

function resolveWhisperCppPath(): string {
  return path.resolve(process.cwd(), 'node_modules', 'nodejs-whisper', 'cpp', 'whisper.cpp');
}

function getWhisperExecutableCandidates(whisperCppPath: string): string[] {
  const execName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  return [
    path.join(whisperCppPath, 'build', 'bin', execName),
    path.join(whisperCppPath, 'build', 'bin', 'Release', execName),
    path.join(whisperCppPath, 'build', 'bin', 'Debug', execName),
    path.join(whisperCppPath, 'build', execName),
    path.join(whisperCppPath, execName),
  ];
}

async function findWhisperCliExecutable(whisperCppPath: string): Promise<string | null> {
  for (const candidate of getWhisperExecutableCandidates(whisperCppPath)) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

let whisperBuildPromise: Promise<void> | null = null;

async function ensureWhisperCliBuilt(): Promise<void> {
  if (whisperBuildPromise) return whisperBuildPromise;

  whisperBuildPromise = (async () => {
    const whisperCppPath = resolveWhisperCppPath();
    if (!(await pathExists(whisperCppPath))) {
      throw new Error(
        'Local Whisper requires the optional dependency `nodejs-whisper`.\n\n' +
          'Install it with:\n' +
          '  bun install\n' +
          'or ensure optional dependencies are not omitted.',
      );
    }

    const existing = await findWhisperCliExecutable(whisperCppPath);
    if (existing) return;

    try {
      await execCmd('cmake', ['--version'], whisperCppPath);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          'Local Whisper requires CMake (`cmake`) to build whisper.cpp.\n\n' +
            'Install CMake:\n' +
            '- macOS (Homebrew): `brew install cmake`\n' +
            '- Ubuntu/Debian: `sudo apt install -y cmake`\n' +
            '- Windows: install CMake or use WSL2',
        );
      }
      throw error;
    }

    console.info('Local Whisper: building whisper.cpp (first run)...');
    await execCmd('cmake', ['-B', 'build'], whisperCppPath);
    await execCmd('cmake', ['--build', 'build', '--config', 'Release'], whisperCppPath);

    const built = await findWhisperCliExecutable(whisperCppPath);
    if (!built) {
      throw new Error(
        'Local Whisper build finished, but `whisper-cli` was not found.\n\n' +
          `Expected one of:\n${getWhisperExecutableCandidates(whisperCppPath)
            .map((p) => `- ${p}`)
            .join('\n')}`,
      );
    }
  })();

  try {
    await whisperBuildPromise;
  } catch (error) {
    whisperBuildPromise = null;
    throw error;
  }
}

function getWhisperModelName(): string {
  const modelName = process.env.WHISPER_MODEL_NAME?.trim();
  if (!modelName) {
    throw new Error(
      'WHISPER_MODEL_NAME is required when USE_LOCAL_WHISPER=true.\n\n' +
        'To find your downloaded model name, list the files in:\n' +
        '  node_modules/nodejs-whisper/cpp/whisper.cpp/models\n' +
        'Example: ggml-large-v3-turbo.bin -> WHISPER_MODEL_NAME=large-v3-turbo\n\n' +
        'If you have not downloaded a model yet, run:\n' +
        '  bunx nodejs-whisper download',
    );
  }
  return modelName;
}

function getWhisperLanguage(originalLanguage?: string): string {
  const language = originalLanguage?.trim();
  if (!language || language === 'auto' || language === 'auto-detect') return 'auto';
  return language;
}

async function runWhisperAndReadJson({
  sourcePath,
  originalLanguage,
}: {
  sourcePath: string;
  originalLanguage?: string;
}): Promise<{ detectedLanguage: string; words: SpeechmaticsWord[]; audioDuration: number }> {
  const originalCwd = process.cwd();
  const modelName = getWhisperModelName();
  const whisperLanguage = getWhisperLanguage(originalLanguage);

  await ensureWhisperCliBuilt();

  const resolvedSourcePath = path.resolve(process.cwd(), sourcePath);
  const tempDir = path.resolve(process.cwd(), 'temporary-files', `whisper-${crypto.randomUUID()}`);
  await ensureDir(tempDir);

  const sourceExt = path.extname(resolvedSourcePath) || '.wav';
  const tempInputPath = path.join(tempDir, `input${sourceExt}`);

  try {
    await fsPromises.copyFile(resolvedSourcePath, tempInputPath);

    const { nodewhisper } = await import('nodejs-whisper');
    await nodewhisper(tempInputPath, {
      modelName,
      removeWavFileAfterTranscription: true,
      whisperOptions: {
        outputInJson: true,
        translateToEnglish: false,
        wordTimestamps: true,
        splitOnWord: true,
        language: whisperLanguage,
      },
    });

    const files = await fsPromises.readdir(tempDir);
    const jsonFile = files.find((f) => f.endsWith('.json'));
    if (!jsonFile) {
      throw new Error('Whisper JSON output not found in temporary directory');
    }
    const jsonPath = path.join(tempDir, jsonFile);

    const jsonRaw = await fsPromises.readFile(jsonPath, 'utf8');
    const parsed = JSON.parse(jsonRaw) as WhisperCliJson;

    const detectedLanguage = parsed.result?.language || 'en';
    const items = parsed.transcription || [];

    const words: SpeechmaticsWord[] = [];
    for (const item of items) {
      const text = item.text?.trim();
      const fromMs = item.offsets?.from;
      const toMs = item.offsets?.to;

      if (!text || typeof fromMs !== 'number' || typeof toMs !== 'number') continue;
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) continue;

      const startSec = Number((fromMs / 1000).toFixed(3));
      const endSec = Number((toMs / 1000).toFixed(3));

      words.push({
        content: text,
        start_time: startSec,
        end_time: endSec,
        confidence: 1,
        type: 'word',
        language: detectedLanguage,
      });
    }

    const audioDuration = words.length > 0 ? words[words.length - 1].end_time : 0;
    return { detectedLanguage, words, audioDuration };
  } catch (error: any) {
    const message = error?.message || String(error);
    const suggestion =
      message.includes('Model file does not exist') || message.includes('Provide model name')
        ? `\n\nTo use local Whisper, ensure:\n- You downloaded a model (e.g. \`bunx nodejs-whisper download\`)\n- \`WHISPER_MODEL_NAME\` matches the downloaded model (check \`node_modules/nodejs-whisper/cpp/whisper.cpp/models\`)`
        : message.includes('ffmpeg') || message.includes('Failed to convert audio file')
          ? `\n\nLocal Whisper requires FFmpeg installed and available on PATH.`
          : '';

    throw new Error(`Local Whisper transcription failed: ${message}${suggestion}`);
  } finally {
    try {
      process.chdir(originalCwd);
    } catch {
      // no-op
    }
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
}

export class WhisperTranscriber {
  static async transcribeAudio({
    audioPath,
    originalLanguage,
  }: {
    audioPath: string;
    originalLanguage?: string;
  }): Promise<SpeechmaticsFormattedResponse> {
    console.debug('Starting transcription with Local Whisper...');

    const { detectedLanguage, words, audioDuration } = await runWhisperAndReadJson({
      sourcePath: audioPath,
      originalLanguage,
    });

    const segments: SpeechmaticsSegment[] = words.map((word, index) => {
      const nextWord = words[index + 1];
      const gapToNext =
        nextWord && Number.isFinite(nextWord.start_time) && Number.isFinite(word.end_time)
          ? Math.max(0, nextWord.start_time - word.end_time)
          : 0;

      const silenceTag = nextWord ? `<${gapToNext.toFixed(3)}s>` : '';

      return {
        transcription: word.content,
        begin: word.start_time,
        end: word.end_time,
        speaker: 1,
        channel: 0,
        confidence: 1,
        language: detectedLanguage,
        duration: Number((word.end_time - word.start_time).toFixed(3)),
        index,
        wordsWithSilence: `${word.content.trim()}${silenceTag}`,
        words: [word],
      };
    });

    return {
      segments,
      detectedLanguage,
      summary: '',
      audioDuration,
    };
  }

  static async transcribeRaw({
    audioPath,
    originalLanguage,
  }: {
    audioPath: string;
    originalLanguage?: string;
  }): Promise<SpeechmaticsTranscriptionResponse> {
    console.debug('Starting raw transcription with Local Whisper...');

    const { detectedLanguage, words, audioDuration } = await runWhisperAndReadJson({
      sourcePath: audioPath,
      originalLanguage,
    });

    const results: SpeechmaticsResult[] = words.map((word) => ({
      alternatives: [
        {
          content: word.content,
          confidence: word.confidence,
          language: detectedLanguage,
        },
      ],
      end_time: word.end_time,
      start_time: word.start_time,
      type: 'word',
    }));

    const now = new Date().toISOString();
    return {
      format: 'whisper-cli-json',
      job: {
        created_at: now,
        data_name: path.basename(audioPath),
        duration: audioDuration,
        id: crypto.randomUUID(),
      },
      metadata: {
        created_at: now,
        type: 'transcription',
        transcription_config: {
          language: getWhisperLanguage(originalLanguage),
        },
      },
      results,
    };
  }
}
