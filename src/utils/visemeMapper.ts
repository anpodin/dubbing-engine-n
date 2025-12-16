// visemeMapper.ts  — turn eSpeak-NG phoneme strings into Papagayo visemes
// ----------------------------------------------------------------------------------

import { spawnSync } from 'child_process';
import type { SpawnSyncReturns } from 'child_process';
import type { AudioOriginalLangAllowed } from '../types';

/** A Papagayo / Preston-Blair viseme code. */
export type VisemeCode =
  | 'AI' // jaw wide open  (as in /a/)
  | 'E' // lips stretched / smile (é, i)
  | 'O' // rounded, mid-open (o, eu)
  | 'U' // rounded, tight  (ou, u)
  | 'etc' // neutral / catch-all consonants
  | 'FV' // upper teeth on lower lip  (f, v)
  | 'L' // tongue up behind teeth    (l)
  | 'MBP' // closed lips               (m, b, p)
  | 'WQ' // exaggerated pucker /w/ or /ɥ/
  | 'Rest'; // mouth relaxed, silence

/** Parameters for sentence → phoneme conversion. */
export interface SentenceToPhonemeArgs {
  lang: string;
  text: string;
}

export function sentenceToPhonemes({ lang, text }: SentenceToPhonemeArgs): string {
  if (!lang || !text) {
    throw new Error("Both 'lang' and 'text' must be provided.");
  }

  const spawnArgs = ['-q', '-x', '-v', lang, text];
  const result: SpawnSyncReturns<string> = spawnSync('espeak-ng', spawnArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024, // plenty for one sentence
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    if (stderr?.includes('No such voice')) {
      throw new Error(`Unsupported language/voice: '${lang}'.`);
    }
    throw new Error(stderr || `espeak-ng exited with status ${result.status}`);
  }

  return result.stdout.trim();
}

/**
 * Single-char eSpeak token → viseme code.
 * Each group carries a short mouth-movement description.
 */
const PHONEME_TO_VISEME: Record<string, VisemeCode> = {
  // ───── MBP – lips closed ─────────────────────────────────────────
  m: 'MBP',
  b: 'MBP',
  p: 'MBP',

  // ───── FV – upper teeth on lower lip ─────────────────────────────
  f: 'FV',
  v: 'FV',

  // ───── L – tongue up behind teeth ───────────────────────────────
  l: 'L',
  L: 'L', // dark l

  // ───── AI – jaw wide open (a / ɑ / ʌ) ───────────────────────────
  a: 'AI',
  A: 'AI',
  V: 'AI',
  Q: 'AI', // lot/cloth vowel

  // ───── E – lips stretched / smile (é, i) ────────────────────────
  e: 'E',
  E: 'E',
  i: 'E',
  I: 'E',
  '3': 'E',
  '@': 'E',

  // ───── O – rounded, mid-open (o, eu) ────────────────────────────
  o: 'O',
  O: 'O',
  '2': 'O',
  '9': 'O',

  // ───── U – rounded, tight (ou, u) ───────────────────────────────
  u: 'U',
  y: 'U',
  U: 'U',

  // ───── WQ – strong pucker /w/ or /ɥ/ ────────────────────────────
  w: 'WQ',
  H: 'WQ',

  // ───── etc – consonants with neutral/clenched teeth position ────
  // Alveolar/dental consonants
  t: 'etc',
  d: 'etc',
  n: 'etc',
  s: 'etc',
  z: 'etc',
  r: 'etc',
  R: 'etc', // tap/flap

  // Postalveolar consonants
  S: 'etc', // sh
  Z: 'etc', // zh (measure)

  // Palatals
  j: 'etc', // yes
  c: 'etc', // palatal stop
  J: 'etc', // palatal nasal (ñ)
  C: 'etc', // ich-laut

  // Velars
  k: 'etc',
  g: 'etc',
  N: 'etc', // ng
  x: 'etc', // German ach
  G: 'etc', // voiced velar fricative

  // Dentals
  T: 'etc', // theta (thin)
  D: 'etc', // eth (this)

  // Glottals
  h: 'etc',
  '?': 'etc', // glottal stop

  // Affricates (treating as single sound)
  q: 'etc', // glottal stop
  X: 'etc', // Scottish loch

  // Additional vowel-like sounds that might appear
  '8': 'O', // rounded schwa
  '&': 'E', // near-open front unrounded
  '7': 'O', // close-mid central unrounded
  '4': 'etc', // rhotic schwa
  '5': 'L', // velarized l
  '6': 'E', // near-open central unrounded

  // Common stress and length markers (ignore)
  ':': 'Rest', // length marker
  '%': 'Rest', // secondary stress
  "'": 'Rest', // primary stress
  ',': 'Rest', // secondary stress
  '.': 'Rest', // syllable boundary
  _: 'Rest', // separator
  '=': 'Rest', // syllabic consonant marker

  // any other symbol defaults to "etc"
};

const STRIP_REGEX = /[~:0-9"'.?,!\s]/;

export interface PhonemeToVisemeOptions {
  dedupe?: boolean; // collapse consecutive duplicates (default: true)
  debug?: boolean; // log unmapped phonemes (default: false)
}

function phonemesToVisemes(
  phonemeLine: string,
  { dedupe = true, debug = false }: PhonemeToVisemeOptions = {},
): VisemeCode[] {
  if (!phonemeLine) return [];

  const visemeSeq: VisemeCode[] = [];
  let prev: VisemeCode | undefined;
  const unmappedPhonemes = new Set<string>();

  for (const char of phonemeLine) {
    if (STRIP_REGEX.test(char)) continue; // ignore junk

    const viseme: VisemeCode = PHONEME_TO_VISEME[char] ?? 'etc';

    // Track unmapped phonemes for debugging
    if (debug && !PHONEME_TO_VISEME[char] && char !== ' ') {
      unmappedPhonemes.add(char);
    }

    if (!dedupe || viseme !== prev) visemeSeq.push(viseme);
    prev = viseme;
  }

  // Log unmapped phonemes if debug is enabled
  if (debug && unmappedPhonemes.size > 0) {
    console.warn(`Unmapped phonemes found: ${Array.from(unmappedPhonemes).join(', ')}`);
    console.warn(`Original phoneme line: "${phonemeLine}"`);
  }

  return visemeSeq;
}

export const textToVisemes = ({
  text,
  lang,
  debug = false,
}: {
  text: string;
  lang: AudioOriginalLangAllowed | 'auto-detect' | 'auto';
  debug?: boolean;
}): VisemeCode[] | null => {
  try {
    const effectiveLang = lang === 'auto-detect' || lang === 'auto' ? 'en' : lang;
    const phonemes = sentenceToPhonemes({ text, lang: effectiveLang });

    if (debug) {
      console.debug(`Text: "${text}"`);
      console.debug(`Language: ${lang}`);
      console.debug(`Phonemes: "${phonemes}"`);
    }

    const visemes = phonemesToVisemes(phonemes, { debug });

    if (debug) {
      console.debug(`Visemes: [${visemes.join(', ')}]`);
      const etcCount = visemes.filter((v) => v === 'etc').length;
      const totalCount = visemes.length;
      const etcPercentage = totalCount > 0 ? ((etcCount / totalCount) * 100).toFixed(1) : '0';
      console.debug(`"etc" visemes: ${etcCount}/${totalCount} (${etcPercentage}%)`);
    }

    return visemes;
  } catch (error) {
    console.error('Error converting text to visemes:', error);
    return null;
  }
};

/**
 * Converts visemes array to a space-separated string for use in prompts
 */
export const visemesToString = (visemes: VisemeCode[] | null): string => {
  if (!visemes || visemes.length === 0) return '';
  return visemes.join(' ');
};

export const clamp = ({ value, min, max }: { value: number; min: number; max: number }) => {
  return Math.max(min, Math.min(value, max));
};
