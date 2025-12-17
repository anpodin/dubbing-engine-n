import { LalalSeparator } from './lalal';
import { DemucsLocal } from './demucs-local';

export interface AudioSeparationResult {
  backgroundAudio: string;
  vocalsIsolated: string;
}

/**
 * Audio separator facade that provides a unified interface for separating
 * vocals from background audio.
 *
 * By default, uses Lalal.ai API + ElevenLabs for high-quality separation.
 * Set USE_LOCAL_DEMUCS=true to use Meta's open-source Demucs library locally.
 *
 * Environment variables:
 * - USE_LOCAL_DEMUCS: Set to "true" to use local Demucs instead of APIs
 * - DEMUCS_PYTHON_BIN: Optional custom Python binary path for Demucs
 * - DEMUCS_PREFER_PYTHON_MODULE: Set to "true" to force using "python -m demucs"
 * - DEMUCS_MODEL: Model to use (default: "htdemucs", alternatives: "htdemucs_ft", "mdx_q")
 * - DEMUCS_DEVICE: Device to use ("cpu" or "cuda", default: "cpu")
 */
export class AudioSeparator {
  /**
   * Determines if local Demucs should be used based on environment variable.
   */
  private static useLocalDemucs(): boolean {
    return process.env.USE_LOCAL_DEMUCS === 'true';
  }

  /**
   * Separates audio into vocals and background (instrumental).
   *
   * When USE_LOCAL_DEMUCS=true:
   * - Uses Meta's open-source Demucs library locally
   * - Requires Python 3.8+ + Demucs + FFmpeg installed on the machine
   * - No API calls, fully offline
   *
   * When USE_LOCAL_DEMUCS is not set or false (default):
   * - Uses Lalal.ai API for background separation (stem extraction)
   * - Uses ElevenLabs API for vocal isolation
   * - Requires LALAL_LICENSE_KEY and ELEVEN_LABS_API_KEY
   *
   * @param audioFilePath - Path to the input audio file
   * @returns Object containing paths to background audio and isolated vocals
   */
  static async getSeparateAudio(audioFilePath: string): Promise<AudioSeparationResult> {
    if (this.useLocalDemucs()) {
      console.info('Audio separation mode: Local Demucs (open-source)');
      return DemucsLocal.getSeparateAudio(audioFilePath);
    }

    console.info('Audio separation mode: Lalal.ai API + ElevenLabs');
    return LalalSeparator.getSeparateAudio(audioFilePath);
  }
}

export { LalalSeparator } from './lalal';
export { DemucsLocal } from './demucs-local';
