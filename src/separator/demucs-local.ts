import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import { ensureDir, pathExists } from '../utils/fsUtils';

export interface DemucsResult {
  vocalsPath: string;
  instrumentalPath: string;
  modelName: string;
  trackName: string;
  stdout: string;
  stderr: string;
}

export interface DemucsOptions {
  inputPath: string;
  outputDir: string;
  model?: string;
  device?: 'cpu' | 'cuda';
  pythonBin?: string;
  preferPythonModule?: boolean;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError?: Error;
}

async function spawnCollect(cmd: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ stdout: '', stderr: '', exitCode: -1, spawnError: err as Error });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      resolve({ stdout, stderr, exitCode: -1, spawnError: err });
    });
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

async function assertFileExists(filePath: string, message: string): Promise<void> {
  const exists = await pathExists(filePath);
  if (!exists) {
    throw new Error(`${message}: ${filePath}`);
  }
  const stat = await fsPromises.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(message);
  }
}

/**
 * Runs Demucs separation in 2-stems mode (vocals vs no_vocals).
 *
 * Machine requirements:
 * - Python 3.8+
 * - `demucs` installed (pip install -U demucs)
 * - FFmpeg available on PATH (especially important on Windows)
 *
 * Output structure:
 *   <outputDir>/<modelName>/<trackName>/(vocals.wav|no_vocals.wav)
 */
export async function demucs2StemsVocals(opts: DemucsOptions): Promise<DemucsResult> {
  const inputPath = path.resolve(opts.inputPath);
  const outputDir = path.resolve(opts.outputDir);
  await ensureDir(outputDir);

  const modelName = opts.model ?? 'htdemucs';
  const device = opts.device ?? 'cpu';

  const trackName = path.parse(inputPath).name;

  const stemDir = path.join(outputDir, modelName, trackName);
  const vocalsPath = path.join(stemDir, 'vocals.wav');
  const instrumentalPath = path.join(stemDir, 'no_vocals.wav');

  const pythonBin = opts.pythonBin;
  const usePythonModule = opts.preferPythonModule ?? false;

  const argsBase: string[] = [];
  argsBase.push('-o', outputDir);
  argsBase.push('--two-stems=vocals');
  argsBase.push('-n', modelName);
  argsBase.push('-d', device);

  const pythonModuleArgs = ['-m', 'demucs', ...argsBase, inputPath];
  const demucsArgs = [...argsBase, inputPath];

  interface AttemptResult {
    cmd: string;
    result: SpawnResult;
  }

  const attempts: AttemptResult[] = [];

  if (usePythonModule && pythonBin) {
    const result = await spawnCollect(pythonBin, pythonModuleArgs);
    attempts.push({ cmd: `${pythonBin} -m demucs`, result });
  } else if (usePythonModule) {
    for (const py of ['python3', 'python']) {
      const result = await spawnCollect(py, pythonModuleArgs);
      attempts.push({ cmd: `${py} -m demucs`, result });
      if (result.exitCode === 0 && !result.spawnError) break;
    }
  } else {
    const demucsResult = await spawnCollect('demucs', demucsArgs);
    attempts.push({ cmd: 'demucs', result: demucsResult });

    if (demucsResult.exitCode !== 0 || demucsResult.spawnError) {
      if (pythonBin) {
        const result = await spawnCollect(pythonBin, pythonModuleArgs);
        attempts.push({ cmd: `${pythonBin} -m demucs`, result });
      } else {
        for (const py of ['python3', 'python']) {
          const result = await spawnCollect(py, pythonModuleArgs);
          attempts.push({ cmd: `${py} -m demucs`, result });
          if (result.exitCode === 0 && !result.spawnError) break;
        }
      }
    }
  }

  const lastAttempt = attempts[attempts.length - 1];
  const succeeded = lastAttempt && lastAttempt.result.exitCode === 0 && !lastAttempt.result.spawnError;

  if (!succeeded) {
    const errorLines = ['Demucs separation failed.'];
    for (const attempt of attempts) {
      const { cmd, result } = attempt;
      const errorMsg = result.spawnError ? result.spawnError.message : result.stderr;
      errorLines.push(`Tried: ${cmd} (exit=${result.exitCode}${result.spawnError ? ', spawn error' : ''})`);
      if (errorMsg) errorLines.push(`  Error: ${errorMsg.trim()}`);
    }
    throw new Error(errorLines.join('\n'));
  }

  await assertFileExists(vocalsPath, 'Missing vocals output');
  await assertFileExists(instrumentalPath, 'Missing no_vocals output');

  return {
    vocalsPath,
    instrumentalPath,
    modelName,
    trackName,
    stdout: lastAttempt.result.stdout,
    stderr: lastAttempt.result.stderr,
  };
}

/**
 * Local Demucs implementation using Meta's open-source Demucs library.
 * Provides the same interface as the Lalal.ai API implementation.
 */
export class DemucsLocal {
  /**
   * Separates audio into vocals and background (instrumental).
   * Uses local Demucs installation instead of external APIs.
   *
   * @param audioFilePath - Path to the input audio file
   * @returns Object containing paths to background audio and isolated vocals
   */
  static async getSeparateAudio(audioFilePath: string): Promise<{
    backgroundAudio: string;
    vocalsIsolated: string;
  }> {
    console.debug('Using local Demucs for audio separation...');

    const jobId = crypto.randomUUID();
    const outputDir = `temporary-files/demucs/${jobId}`;

    try {
      const pythonBin = process.env.DEMUCS_PYTHON_BIN || undefined;
      const preferPythonModule = process.env.DEMUCS_PREFER_PYTHON_MODULE === 'true';
      const model = process.env.DEMUCS_MODEL || 'htdemucs';
      const demucsDeviceEnv = process.env.DEMUCS_DEVICE;
      let device: 'cpu' | 'cuda' = 'cpu';
      if (demucsDeviceEnv) {
        if (demucsDeviceEnv !== 'cpu' && demucsDeviceEnv !== 'cuda') {
          console.warn(`Invalid DEMUCS_DEVICE value: "${demucsDeviceEnv}". Must be "cpu" or "cuda". Defaulting to "cpu".`);
        } else {
          device = demucsDeviceEnv;
        }
      }

      const result = await demucs2StemsVocals({
        inputPath: audioFilePath,
        outputDir,
        pythonBin,
        preferPythonModule,
        model,
        device,
      });

      console.debug('Local Demucs separation completed successfully.');
      console.debug('Vocals path:', result.vocalsPath);
      console.debug('Instrumental path:', result.instrumentalPath);

      return {
        backgroundAudio: result.instrumentalPath,
        vocalsIsolated: result.vocalsPath,
      };
    } catch (error) {
      console.error('Error in local Demucs getSeparateAudio:', error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Error in local Demucs getSeparateAudio');
    }
  }
}
