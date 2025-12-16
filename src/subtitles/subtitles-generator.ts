import { VideoUtils } from '../ffmpeg/video-utils';
import { Transcriber } from '../transcription/transcriber';
import type { AllowedLanguages, SegmentWitDurationAndOriginalSegment } from '../types';
import type {
  SpeechmaticsTranscriptionResponse,
  SpeechmaticsResult,
  SpeechmaticsWord,
} from '../types/speechmatics';
import fs from 'fs';
import crypto from 'crypto';
import { safeUnlink } from '../utils/fsUtils';

type Cue = { start: number; end: number; text: string; chars: number };

type LangProfile = {
  isCJK: boolean;
  cps: number;
  maxCharsPerLine: number;
  linesPerCue: number;
  minDuration: number;
  maxDuration: number;
  minGap: number;
  mergeThresholdSec: number;
  mergeCharThreshold: number;
  maxCharsPerCue: number;
};

type WordTiming = { text: string; start: number; end: number };

export class SubtitlesGenerator {
  static async addSubtitlesInVideo({
    transcriptionData,
    initialVideoPath,
    lang,
    audioPath,
  }: {
    transcriptionData: SegmentWitDurationAndOriginalSegment[];
    initialVideoPath: string;
    lang: AllowedLanguages;
    audioPath?: string;
  }): Promise<string> {
    console.debug('Adding subtitles in video...');

    const { orientation } = await VideoUtils.getVideoOrientation(initialVideoPath);

    let srtContent: string;
    if (orientation === 'vertical') {
      console.debug('Video detected as vertical. Generating word-synced vertical subtitles...');

      const fileToTranscribe = audioPath || initialVideoPath;
      const nativeTranscription = await Transcriber.transcribeRaw({
        audioPath: fileToTranscribe,
      });

      const nativeWords = this.extractNativeWordsFromSpeechmatics(nativeTranscription);
      srtContent = this.createSrtForVerticalFromNativeWords(nativeWords, lang);
    } else {
      const maxLengthText = 50;
      srtContent = this.createSrt(transcriptionData, maxLengthText, lang);
    }

    const srtFilePath = `temporary-files/subtitles-${crypto.randomUUID()}.srt`;
    fs.writeFileSync(srtFilePath, srtContent, 'utf8');
    const outputVideoFilePath = `output/result-${crypto.randomUUID()}.mp4`;

    try {
      await VideoUtils.addSubtitles({
        videoPath: initialVideoPath,
        srtFilePath: srtFilePath,
        outputFilePath: outputVideoFilePath,
      });

      return outputVideoFilePath;
    } catch (err) {
      console.error(err);
      throw new Error('Error while adding subtitles');
    } finally {
      await safeUnlink(srtFilePath);
      await safeUnlink(initialVideoPath);
    }
  }

  static extractNativeWordsFromSpeechmatics(
    transcriptionData: SpeechmaticsTranscriptionResponse,
  ): WordTiming[] {
    try {
      const out: WordTiming[] = [];
      for (const res of transcriptionData.results as SpeechmaticsResult[]) {
        if (res.type === 'word') {
          const alt = res.alternatives?.[0];
          if (alt) {
            out.push({
              text: alt.content,
              start: res.start_time,
              end: res.end_time,
            });
          }
        }
      }
      return out.sort((a, b) => a.start - b.start || a.end - b.end);
    } catch {
      return [];
    }
  }

  static extractNativeWordsFromSegments(segments: { words?: SpeechmaticsWord[] }[]): WordTiming[] {
    const out: WordTiming[] = [];
    for (const seg of segments) {
      if (seg.words) {
        for (const w of seg.words) {
          if (w.type === 'word') {
            out.push({
              text: w.content,
              start: w.start_time,
              end: w.end_time,
            });
          }
        }
      }
    }
    return out.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  static createSrtForVerticalFromNativeWords(nativeWords: WordTiming[], language: AllowedLanguages): string {
    const profile = this.getLangProfileForVertical(language);
    const words = (nativeWords || [])
      .filter((w) => w && typeof w.start === 'number' && typeof w.end === 'number' && w.end > w.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);

    const cues: Cue[] = [];
    const maxWordsPerCue = 2;
    const maxWordGapSec = 0.8;
    const hardMaxDuration = 3.0;

    let i = 0;
    while (i < words.length) {
      const group: WordTiming[] = [];
      let groupText = '';
      let groupStart = words[i].start;
      let groupEnd = words[i].end;
      let count = 0;

      while (i < words.length && count < maxWordsPerCue) {
        const w = words[i];
        const gap = group.length ? w.start - group[group.length - 1].end : 0;
        const candidateText = groupText ? groupText + ' ' + w.text : w.text;

        const tooLong = this.visibleLength(candidateText, profile) > profile.maxCharsPerCue;
        const tooSlow = w.end - groupStart > hardMaxDuration;
        const largeGap = group.length > 0 && gap > maxWordGapSec;

        if (tooLong || tooSlow || largeGap) break;

        group.push(w);
        groupText = candidateText;
        groupEnd = w.end;
        count++;
        i++;
      }

      if (!group.length) {
        const w = words[i++];
        group.push(w);
        groupText = w.text;
        groupStart = w.start;
        groupEnd = w.end;
      }

      const text = this.lineBreakCueVertical(groupText, profile);
      cues.push({
        start: groupStart,
        end: groupEnd,
        text,
        chars: this.visibleLength(text, profile),
      });
    }

    const processed = this.postProcessTimelineVertical(cues, profile);

    let srt = '';
    let idx = 1;
    for (const c of processed) {
      if (!isFinite(c.start) || !isFinite(c.end) || c.end <= c.start) continue;
      const cleanedText = this.removeBreakTags(c.text);
      srt +=
        idx++ +
        '\n' +
        this.secondsToSrtTime(c.start) +
        ' --> ' +
        this.secondsToSrtTime(c.end) +
        '\n' +
        cleanedText +
        '\n\n';
    }
    return srt.trimEnd() + '\n';
  }

  static createSrt(
    subtitles: SegmentWitDurationAndOriginalSegment[] = [],
    maxLineLength: number,
    language: AllowedLanguages | string,
  ): string {
    const langProfile = this.getLangProfile(language as string, maxLineLength);

    const normalizedSegments = (subtitles || [])
      .filter((seg) => seg && String(seg.transcription || '').trim().length > 0)
      .map((seg) => ({
        begin: Math.max(0, this.toNumber(seg.begin)),
        end: Math.max(0, this.toNumber(seg.end)),
        text: this.normalizeText(String(seg.transcription || ''), langProfile),
        language: (seg.language || language) + '',
      }))
      .sort((a, b) => a.begin - b.begin || a.end - b.end);

    for (let i = 0; i < normalizedSegments.length; i++) {
      const previousEnd = i > 0 ? normalizedSegments[i - 1].end : 0;
      normalizedSegments[i].begin = Math.max(normalizedSegments[i].begin, previousEnd + langProfile.minGap);
      if (!isFinite(normalizedSegments[i].end) || normalizedSegments[i].end <= normalizedSegments[i].begin) {
        normalizedSegments[i].end = normalizedSegments[i].begin + Math.max(langProfile.minDuration, 0.2);
      }
    }

    let cueList: Cue[] = [];
    let lastCueEnd = 0;

    for (let i = 0; i < normalizedSegments.length; i++) {
      const segment = normalizedSegments[i];
      const nextSegmentStart = i < normalizedSegments.length - 1 ? normalizedSegments[i + 1].begin : Infinity;

      const segmentStart = Math.max(segment.begin, lastCueEnd + langProfile.minGap);
      const hardSegmentEnd = Math.min(
        segment.end,
        isFinite(nextSegmentStart) ? nextSegmentStart - langProfile.minGap : segment.end,
      );
      const availableWindow = Math.max(0.05, hardSegmentEnd - segmentStart);

      const textChunks = this.chunkTextToCues(segment.text, langProfile);
      const chunkVisibleLengths = textChunks.map((chunk) => this.visibleLength(chunk, langProfile));

      const idealDurations = chunkVisibleLengths.map((chars) =>
        Math.max(langProfile.minDuration, chars / langProfile.cps),
      );
      const totalIdealDuration = idealDurations.reduce((a, b) => a + b, 0);

      const chunkDurations = idealDurations.slice();
      if (totalIdealDuration <= availableWindow) {
        const slackTime = availableWindow - totalIdealDuration;
        const distributionWeights = chunkVisibleLengths.map((c) => c || 1);
        const totalWeight = distributionWeights.reduce((a, b) => a + b, 0);
        for (let k = 0; k < chunkDurations.length; k++) {
          chunkDurations[k] = Math.min(
            langProfile.maxDuration,
            chunkDurations[k] + (slackTime * distributionWeights[k]) / totalWeight,
          );
        }
      } else {
        const compressionScale = availableWindow / totalIdealDuration;
        for (let k = 0; k < chunkDurations.length; k++) {
          chunkDurations[k] = Math.max(langProfile.minDuration, chunkDurations[k] * compressionScale);
        }
        let totalDuration = chunkDurations.reduce((a, b) => a + b, 0);
        if (totalDuration > availableWindow) {
          const longestFirst = [...chunkDurations.keys()].sort(
            (a, b) => chunkDurations[b] - chunkDurations[a],
          );
          let orderIndex = 0;
          while (totalDuration > availableWindow && orderIndex < longestFirst.length) {
            const idx = longestFirst[orderIndex];
            const canShave = Math.max(0, chunkDurations[idx] - langProfile.minDuration);
            const neededReduction = totalDuration - availableWindow;
            const shaveAmount = Math.min(canShave, neededReduction);
            chunkDurations[idx] -= shaveAmount;
            totalDuration -= shaveAmount;
            if (canShave <= neededReduction) orderIndex++;
          }
        }
      }

      let segmentCursor = segmentStart;
      for (let k = 0; k < textChunks.length; k++) {
        const cueStart = Math.max(segmentCursor, lastCueEnd + langProfile.minGap);
        let cueEnd = cueStart + chunkDurations[k];

        if (cueEnd > hardSegmentEnd) cueEnd = hardSegmentEnd;

        const cueText = this.lineBreakCue(textChunks[k], langProfile);
        cueList.push({
          start: cueStart,
          end: cueEnd,
          text: cueText,
          chars: chunkVisibleLengths[k],
        });
        segmentCursor = cueEnd;
        lastCueEnd = cueEnd;
      }
    }

    cueList = this.postProcessTimeline(cueList, langProfile);

    let srtOutput = '';
    let srtIndex = 1;
    for (const cue of cueList) {
      if (!isFinite(cue.start) || !isFinite(cue.end) || cue.end <= cue.start) continue;
      const finalText = langProfile.isCJK ? cue.text : this.ensureTwoLinesHorizontal(cue.text, langProfile);
      const cleanedText = this.removeBreakTags(finalText);
      srtOutput +=
        srtIndex++ +
        '\n' +
        this.secondsToSrtTime(cue.start) +
        ' --> ' +
        this.secondsToSrtTime(cue.end) +
        '\n' +
        cleanedText +
        '\n\n';
    }
    return srtOutput.trimEnd() + '\n';
  }

  private static getLangProfile(language: string, maxCharsPerLineOverride?: number): LangProfile {
    const normalizedLang = this.normalizeLang(language);
    const isCJK = ['ja', 'japanese', 'ko', 'korean', 'zh', 'chinese', 'mandarin'].includes(normalizedLang);
    const isArabic = ['arabic', 'ar'].includes(normalizedLang);

    const maxCharsPerLineLatin = this.clampInt(maxCharsPerLineOverride || 42, 24, 50);
    const maxCharsPerLineCJK = this.clampInt(Math.min(maxCharsPerLineOverride || 18, 22), 10, 22);

    const profile: LangProfile = {
      isCJK,
      cps: isCJK ? 9 : isArabic ? 13 : 17,
      maxCharsPerLine: isCJK ? maxCharsPerLineCJK : maxCharsPerLineLatin,
      linesPerCue: 2,
      minDuration: isCJK ? 1.0 : 0.9,
      maxDuration: 7.0,
      minGap: 0.08,
      mergeThresholdSec: 1.0,
      mergeCharThreshold: isCJK ? 10 : 8,
      maxCharsPerCue: 0,
    };
    profile.maxCharsPerCue = profile.maxCharsPerLine * profile.linesPerCue;
    return profile;
  }

  private static getLangProfileForVertical(language: string, maxCharsPerLineOverride?: number): LangProfile {
    const normalizedLang = this.normalizeLang(language);
    const isCJK = ['ja', 'japanese', 'ko', 'korean', 'zh', 'chinese', 'mandarin'].includes(normalizedLang);
    const isArabic = ['arabic', 'ar'].includes(normalizedLang);

    const maxCharsPerLineLatin = this.clampInt(maxCharsPerLineOverride || 18, 10, 30);
    const maxCharsPerLineCJK = this.clampInt(Math.min(maxCharsPerLineOverride || 12, 18), 6, 22);

    const profile: LangProfile = {
      isCJK,
      cps: isCJK ? 9 : isArabic ? 12 : 15,
      maxCharsPerLine: isCJK ? maxCharsPerLineCJK : maxCharsPerLineLatin,
      linesPerCue: 2,
      minDuration: isCJK ? 0.9 : 0.8,
      maxDuration: 4.0,
      minGap: 0.0,
      mergeThresholdSec: 0.8,
      mergeCharThreshold: isCJK ? 8 : 6,
      maxCharsPerCue: 0,
    };
    profile.maxCharsPerCue = profile.maxCharsPerLine * profile.linesPerCue;
    return profile;
  }

  private static lineBreakCueVertical(text: string, profile: LangProfile): string {
    const maxCharsPerLine = profile.maxCharsPerLine;
    const trimmed = String(text || '').trim();
    const visibleLen = this.visibleLength(trimmed, profile);
    if (visibleLen <= maxCharsPerLine) return trimmed;

    const hardMax = maxCharsPerLine * profile.linesPerCue;
    const safeText = visibleLen > hardMax ? this.truncateToVisible(trimmed, hardMax, profile) : trimmed;

    const totalVisible = this.visibleLength(safeText, profile);
    const targetFirst = Math.min(maxCharsPerLine, Math.ceil(totalVisible / 2));
    let splitIdx = this.splitIndexByVisible(safeText, targetFirst, profile, true);

    if (splitIdx <= 0) {
      splitIdx = this.splitIndexByVisible(safeText, maxCharsPerLine, profile, false);
      if (splitIdx <= 0) splitIdx = Math.min(safeText.length, maxCharsPerLine);
    }

    const first = safeText.slice(0, splitIdx).trim();
    let second = safeText.slice(splitIdx).trim();

    if (this.visibleLength(second, profile) > maxCharsPerLine) {
      second = this.truncateToVisible(second, maxCharsPerLine, profile);
    }

    if (!first) return second;
    if (!second) return first;
    return first + '\n' + second;
  }

  private static postProcessTimelineVertical(cueList: Cue[], profile: LangProfile): Cue[] {
    if (!cueList.length) return cueList;

    const out: Cue[] = cueList.map((c) => ({ ...c }));

    for (let i = 0; i < out.length; i++) {
      const prev = out[i - 1];
      const cue = out[i];
      const next = out[i + 1];

      if (!Number.isFinite(cue.start)) cue.start = 0;
      if (!Number.isFinite(cue.end)) cue.end = cue.start;
      if (cue.end <= cue.start) cue.end = cue.start + 0.01;

      if (prev && cue.start < prev.end) cue.start = prev.end;
      if (next && cue.end > next.start) cue.end = next.start;
      if (cue.end <= cue.start) cue.end = cue.start + 0.01;

      cue.text = this.ensureTwoLines(cue.text, profile);
      cue.chars = this.visibleLength(cue.text, profile);
    }

    return out;
  }

  private static ensureTwoLines(text: string, profile: LangProfile): string {
    const normalized = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    const rebuilt = this.lineBreakCueVertical(normalized, profile);
    const parts = rebuilt.split(/\r?\n/);
    if (parts.length <= 2) return rebuilt;
    const first = parts[0].trim();
    const secondJoined = parts.slice(1).join(' ').trim();
    const second = this.truncateToVisible(secondJoined, profile.maxCharsPerLine, profile);
    return first + (second ? '\n' + second : '');
  }

  private static normalizeLang(lang: string): string {
    const val = String(lang || '')
      .trim()
      .toLowerCase();
    if (!val) return 'english';
    if (val.includes('english')) return 'english';
    if (val.includes('british')) return 'english';
    if (val.includes('american')) return 'english';
    if (val.includes('portuguese') && val.includes('brazil')) return 'pt-br';
    if (val.includes('pt_brazil')) return 'pt-br';
    if (val.includes('chinese') || val.includes('mandarin') || val === 'zh' || val.startsWith('zh-'))
      return 'zh';
    if (val.includes('japanese') || val === 'ja') return 'ja';
    if (val.includes('korean') || val === 'ko') return 'ko';
    if (val.includes('arabic') || val === 'ar') return 'arabic';
    return val;
  }

  private static ensureTwoLinesHorizontal(text: string, profile: LangProfile): string {
    const normalized = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    const rebuilt = this.lineBreakCue(normalized, profile);
    const parts = rebuilt.split(/\r?\n/);
    if (parts.length <= 2) return rebuilt;
    const first = parts[0].trim();
    const secondJoined = parts.slice(1).join(' ').trim();
    const second = this.truncateToVisible(secondJoined, profile.maxCharsPerLine, profile);
    return second ? `${first}\n${second}` : first;
  }

  private static normalizeText(text: string, profile: LangProfile): string {
    const sanitizedInput = this.removeBreakTags(String(text || ''));
    let normalized = sanitizedInput.replace(/\s+/g, ' ').trim();
    if (profile.isCJK) {
      normalized = normalized
        .replace(/\s*([。！？，、；：""『』「」（）【】—…])/g, '$1')
        .replace(/([。！？，、；：""『』「」（）【】—…])\s*/g, '$1');
    }
    return normalized;
  }

  private static chunkTextToCues(text: string, profile: LangProfile): string[] {
    const maxCharsPerCue = profile.maxCharsPerCue;
    if (!text) return [];

    const sentences = this.splitByPunctuation(text, profile);
    const cueTexts: string[] = [];

    for (const sentence of sentences) {
      const sentenceVisibleLen = this.visibleLength(sentence, profile);
      if (sentenceVisibleLen <= maxCharsPerCue) {
        cueTexts.push(sentence);
        continue;
      }
      if (profile.isCJK) {
        const minorChunks = this.splitCJKMinor(sentence);
        for (const minor of minorChunks) {
          this.sliceIntoCues(minor, maxCharsPerCue, cueTexts, profile);
        }
      } else {
        const words = sentence.split(' ');
        let currentLine = '';
        for (const word of words) {
          const candidate = currentLine ? currentLine + ' ' + word : word;
          if (this.visibleLength(candidate, profile) <= maxCharsPerCue) {
            currentLine = candidate;
          } else {
            if (currentLine) cueTexts.push(currentLine);
            currentLine = word;
          }
        }
        if (currentLine) cueTexts.push(currentLine);
      }
    }

    return cueTexts;
  }

  private static splitByPunctuation(text: string, profile: LangProfile): string[] {
    const hardPunctSet = profile.isCJK
      ? new Set(['。', '！', '？', '…', '!', '?', '.', '；', ';'])
      : new Set(['.', '!', '?', '…', ';', '。', '！', '？', '；']);
    const softPunctSet = profile.isCJK
      ? new Set(['、', '，', ',', '：', ':'])
      : new Set([',', ':', '，', '：']);

    const sentences: string[] = [];
    let buffer = '';

    for (const char of Array.from(text)) {
      buffer += char;
      if (hardPunctSet.has(char)) {
        this.pushIfNonEmpty(sentences, buffer);
        buffer = '';
      } else if (!profile.isCJK && char === '\n') {
        this.pushIfNonEmpty(sentences, buffer.replace(/\n+/g, ' ').trim());
        buffer = '';
      }
    }
    if (buffer.trim()) this.pushIfNonEmpty(sentences, buffer);

    if (sentences.length === 1 && this.visibleLength(sentences[0], profile) > profile.maxCharsPerCue * 1.2) {
      const tempParts: string[] = [];
      let accumulator = '';
      for (const char of Array.from(sentences[0])) {
        accumulator += char;
        if (softPunctSet.has(char) && this.visibleLength(accumulator, profile) >= profile.maxCharsPerLine) {
          this.pushIfNonEmpty(tempParts, accumulator);
          accumulator = '';
        }
      }
      if (accumulator.trim()) this.pushIfNonEmpty(tempParts, accumulator);
      if (tempParts.length > 0) return tempParts;
    }

    return sentences;
  }

  private static splitCJKMinor(sentence: string): string[] {
    const parts: string[] = [];
    let buffer = '';
    const minorPunctSet = new Set(['、', '，', ',', '：', ':', '；', ';', '—']);
    for (const char of Array.from(sentence)) {
      buffer += char;
      if (minorPunctSet.has(char)) {
        this.pushIfNonEmpty(parts, buffer);
        buffer = '';
      }
    }
    if (buffer.trim()) this.pushIfNonEmpty(parts, buffer);
    return parts.length ? parts : [sentence];
  }

  private static sliceIntoCues(
    text: string,
    maxCharsPerCue: number,
    outputList: string[],
    profile: LangProfile,
  ): void {
    let buffer = '';
    for (const char of Array.from(text)) {
      const candidate = buffer + char;
      if (this.visibleLength(candidate, profile) > maxCharsPerCue) {
        if (buffer) outputList.push(buffer);
        buffer = char;
      } else {
        buffer = candidate;
      }
    }
    if (buffer) outputList.push(buffer);
  }

  private static lineBreakCue(text: string, profile: LangProfile): string {
    const maxCharsPerLine = profile.maxCharsPerLine;
    const trimmedText = text.trim();
    const visibleLen = this.visibleLength(trimmedText, profile);

    if (visibleLen <= maxCharsPerLine) return trimmedText;
    const hardMaxChars = maxCharsPerLine * profile.linesPerCue;

    const safeText =
      visibleLen > hardMaxChars ? this.truncateToVisible(trimmedText, hardMaxChars, profile) : trimmedText;

    if (profile.isCJK) {
      const targetLen = Math.min(maxCharsPerLine, Math.ceil(this.visibleLength(safeText, profile) / 2));
      const splitIdx = this.splitIndexByVisible(safeText, targetLen, profile, false);
      return safeText.slice(0, splitIdx) + '\n' + safeText.slice(splitIdx);
    } else {
      const safeNoBreaks = safeText.replace(/\s*\r?\n\s*/g, ' ');
      const words = safeNoBreaks.split(' ');
      let firstLine = '';
      for (const word of words) {
        const candidate = firstLine ? firstLine + ' ' + word : word;
        if (this.visibleLength(candidate, profile) <= maxCharsPerLine) firstLine = candidate;
        else break;
      }
      const secondLine = safeNoBreaks.slice(firstLine.length).trim();
      if (!secondLine) return firstLine;
      return firstLine + '\n' + secondLine;
    }
  }

  private static visibleLength(text: string, profile: LangProfile): number {
    if (profile.isCJK) {
      return Array.from(text.replace(/\s+/g, '')).length;
    }
    return text.replace(/\s+/g, ' ').trim().length;
  }

  private static truncateToVisible(text: string, maxVisibleChars: number, profile: LangProfile): string {
    const codepoints = Array.from(text);
    let result = '';
    for (const ch of codepoints) {
      if (this.visibleLength(result + ch, profile) > maxVisibleChars) break;
      result += ch;
    }
    return result;
  }

  private static splitIndexByVisible(
    text: string,
    targetIndex: number,
    profile: LangProfile,
    preferSpace: boolean,
  ): number {
    if (profile.isCJK) {
      const codepoints = Array.from(text);
      return codepoints.slice(0, targetIndex).join('').length;
    }
    const leftSpaceIdx = text.lastIndexOf(' ', targetIndex);
    const rightSpaceIdx = text.indexOf(' ', targetIndex);
    if (preferSpace) {
      if (leftSpaceIdx !== -1) return leftSpaceIdx;
      if (rightSpaceIdx !== -1) return rightSpaceIdx;
    }
    return targetIndex;
  }

  private static postProcessTimeline(cueList: Cue[], profile: LangProfile): Cue[] {
    if (!cueList.length) return cueList;

    const mergedCues: Cue[] = [];
    for (let i = 0; i < cueList.length; i++) {
      const currentCue = { ...cueList[i] };
      const currentDuration = currentCue.end - currentCue.start;
      if (
        i < cueList.length - 1 &&
        (currentDuration < profile.mergeThresholdSec || currentCue.chars < profile.mergeCharThreshold)
      ) {
        const nextCue = cueList[i + 1];
        const combinedVisibleChars = currentCue.chars + nextCue.chars + 1;
        if (
          combinedVisibleChars <= profile.maxCharsPerCue &&
          nextCue.start - currentCue.end <= profile.minGap * 2
        ) {
          const mergedText = this.lineBreakCue(
            currentCue.text + (profile.isCJK ? '' : ' ') + nextCue.text,
            profile,
          );
          mergedCues.push({
            start: currentCue.start,
            end: Math.max(nextCue.end, currentCue.end + profile.minDuration),
            text: mergedText,
            chars: this.visibleLength(mergedText, profile),
          });
          i++;
          continue;
        }
      }
      mergedCues.push(currentCue);
    }

    for (let i = 0; i < mergedCues.length; i++) {
      const prevCue = mergedCues[i - 1];
      const cue = mergedCues[i];
      const nextCue = mergedCues[i + 1];

      if (prevCue && cue.start < prevCue.end + profile.minGap) cue.start = prevCue.end + profile.minGap;

      const minRequiredDuration = Math.max(profile.minDuration, cue.chars / profile.cps);
      if (cue.end - cue.start < minRequiredDuration) cue.end = cue.start + minRequiredDuration;

      if (cue.end - cue.start > profile.maxDuration) cue.end = cue.start + profile.maxDuration;

      if (nextCue && cue.end > nextCue.start - profile.minGap) {
        cue.end = Math.max(cue.start + profile.minDuration, nextCue.start - profile.minGap);
      }

      if (cue.end <= cue.start) cue.end = cue.start + profile.minDuration;

      cue.text = this.lineBreakCue(cue.text, profile);
      cue.chars = this.visibleLength(cue.text, profile);
    }

    for (let i = 1; i < mergedCues.length; i++) {
      if (mergedCues[i].start < mergedCues[i - 1].end + profile.minGap) {
        mergedCues[i].start = mergedCues[i - 1].end + profile.minGap;
        if (mergedCues[i].end <= mergedCues[i].start) {
          mergedCues[i].end = mergedCues[i].start + profile.minDuration;
        }
      }
    }

    return mergedCues;
  }

  static secondsToSrtTime(seconds: number): string {
    const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const totalMs = Math.round(safeSeconds * 1000);
    const hours = Math.floor(totalMs / 3_600_000);
    const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
    const secs = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;
    return (
      String(hours).padStart(2, '0') +
      ':' +
      String(minutes).padStart(2, '0') +
      ':' +
      String(secs).padStart(2, '0') +
      ',' +
      String(ms).padStart(3, '0')
    );
  }

  private static clampInt(n: number, lo: number, hi: number): number {
    return Math.floor(Math.max(lo, Math.min(hi, Number(n) || 0)));
  }

  private static toNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private static pushIfNonEmpty(list: string[], text: string): void {
    const trimmed = String(text || '').trim();
    if (trimmed) list.push(trimmed);
  }

  private static removeBreakTags(text: string): string {
    if (!text) return '';
    const breakTagRegex = /<\s*\/?\s*break\b[^>]*>/gi;
    const partialBreakRegex = /<\s*break\b[^\r\n>]*/gi;
    return text
      .replace(breakTagRegex, ' ')
      .replace(partialBreakRegex, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
}
