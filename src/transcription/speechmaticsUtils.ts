import type {
  SpeechmaticsTranscriptionResponse,
  SpeechmaticsFormattedResponse,
  SpeechmaticsSegment,
  SpeechmaticsResult,
  SpeechmaticsSpeaker,
  SpeechmaticsWord,
} from '../types/speechmatics';

function extractDetectedLanguage(
  results: SpeechmaticsResult[],
  configLanguage?: string,
  languagePackInfo?: { language_description?: string },
): string {
  if (configLanguage && configLanguage !== 'auto') {
    return configLanguage;
  }

  for (const result of results) {
    if (result.type === 'word' && result.alternatives?.[0]?.language) {
      return result.alternatives[0].language;
    }
  }

  if (languagePackInfo?.language_description) {
    const langDesc = languagePackInfo.language_description.toLowerCase();
    const langMap: Record<string, string> = {
      english: 'en',
      french: 'fr',
      spanish: 'es',
      german: 'de',
      italian: 'it',
      portuguese: 'pt',
      dutch: 'nl',
      russian: 'ru',
      japanese: 'ja',
      korean: 'ko',
      chinese: 'zh',
      mandarin: 'cmn',
      arabic: 'ar',
      hindi: 'hi',
      polish: 'pl',
      turkish: 'tr',
      swedish: 'sv',
      danish: 'da',
      norwegian: 'no',
      finnish: 'fi',
    };
    for (const [desc, code] of Object.entries(langMap)) {
      if (langDesc.includes(desc)) {
        return code;
      }
    }
  }

  return 'en';
}

export function formatSpeechmaticsResponse(
  rawResponse: SpeechmaticsTranscriptionResponse,
): SpeechmaticsFormattedResponse {
  const results = rawResponse.results || [];
  const speakers = rawResponse.speakers || [];
  const summary = rawResponse.summarization?.content || '';
  const audioDuration = rawResponse.job?.duration || 0;

  const configLanguage = rawResponse.metadata?.transcription_config?.language;
  const languagePackInfo = rawResponse.metadata?.language_pack_info;
  const detectedLanguage = extractDetectedLanguage(results, configLanguage, languagePackInfo);

  const hasDiarization = speakers.length > 0;

  const segments = hasDiarization
    ? createSegmentsFromSpeakers(results, speakers, detectedLanguage)
    : createSegmentsWithoutDiarization(results, detectedLanguage);

  return {
    segments,
    detectedLanguage,
    summary,
    audioDuration,
  };
}

function createSegmentsFromSpeakers(
  results: SpeechmaticsResult[],
  speakers: SpeechmaticsSpeaker[],
  detectedLanguage: string,
): SpeechmaticsSegment[] {
  const segments: SpeechmaticsSegment[] = [];

  for (let i = 0; i < speakers.length; i++) {
    const speaker = speakers[i];
    const speakerNumber = parseSpeakerNumber(speaker.speaker);

    const wordsInRange = results.filter(
      (r) => r.type === 'word' && r.start_time >= speaker.start_time && r.end_time <= speaker.end_time,
    );

    const punctuationInRange = results.filter(
      (r) =>
        r.type === 'punctuation' &&
        r.start_time >= speaker.start_time &&
        r.end_time <= speaker.end_time + 0.1,
    );

    if (wordsInRange.length === 0) continue;

    const transcription = buildTranscriptionText(wordsInRange, punctuationInRange);
    const words = buildWordsArray(wordsInRange);
    const wordsWithSilence = addTimesInText(words);

    const totalConfidence = wordsInRange.reduce((sum, w) => {
      const conf = w.alternatives?.[0]?.confidence ?? 1;
      return sum + conf;
    }, 0);
    const avgConfidence = wordsInRange.length > 0 ? totalConfidence / wordsInRange.length : 1;

    const begin = speaker.start_time;
    const end = speaker.end_time;
    const duration = end - begin;

    const segmentLanguage = words[0]?.language || detectedLanguage;

    segments.push({
      transcription,
      begin: Number(begin.toFixed(3)),
      end: Number(end.toFixed(3)),
      speaker: speakerNumber,
      channel: 0,
      confidence: Number(avgConfidence.toFixed(2)),
      language: segmentLanguage,
      duration: Number(duration.toFixed(3)),
      index: i,
      wordsWithSilence,
      words,
    });
  }

  return segments;
}

function createSegmentsWithoutDiarization(
  results: SpeechmaticsResult[],
  detectedLanguage: string,
): SpeechmaticsSegment[] {
  const segments: SpeechmaticsSegment[] = [];
  let currentWords: SpeechmaticsResult[] = [];
  let currentPunctuation: SpeechmaticsResult[] = [];
  let segmentIndex = 0;

  for (const result of results) {
    if (result.type === 'word') {
      currentWords.push(result);
    } else if (result.type === 'punctuation') {
      currentPunctuation.push(result);

      const content = result.alternatives?.[0]?.content || '';
      if (['.', '!', '?'].includes(content) && currentWords.length > 0) {
        const segment = createSegmentFromWords(
          currentWords,
          currentPunctuation,
          detectedLanguage,
          segmentIndex,
          0,
        );
        segments.push(segment);
        segmentIndex++;
        currentWords = [];
        currentPunctuation = [];
      }
    }
  }

  if (currentWords.length > 0) {
    const segment = createSegmentFromWords(
      currentWords,
      currentPunctuation,
      detectedLanguage,
      segmentIndex,
      0,
    );
    segments.push(segment);
  }

  return segments;
}

function createSegmentFromWords(
  words: SpeechmaticsResult[],
  punctuation: SpeechmaticsResult[],
  detectedLanguage: string,
  index: number,
  speaker: number,
): SpeechmaticsSegment {
  const transcription = buildTranscriptionText(words, punctuation);
  const wordsArray = buildWordsArray(words);
  const wordsWithSilence = addTimesInText(wordsArray);

  const totalConfidence = words.reduce((sum, w) => {
    const conf = w.alternatives?.[0]?.confidence ?? 1;
    return sum + conf;
  }, 0);
  const avgConfidence = words.length > 0 ? totalConfidence / words.length : 1;

  const begin = words[0]?.start_time ?? 0;
  const end = words[words.length - 1]?.end_time ?? 0;
  const duration = end - begin;

  const segmentLanguage = wordsArray[0]?.language || detectedLanguage;

  return {
    transcription,
    begin: Number(begin.toFixed(3)),
    end: Number(end.toFixed(3)),
    speaker,
    channel: 0,
    confidence: Number(avgConfidence.toFixed(2)),
    language: segmentLanguage,
    duration: Number(duration.toFixed(3)),
    index,
    wordsWithSilence,
    words: wordsArray,
  };
}

function buildTranscriptionText(words: SpeechmaticsResult[], punctuation: SpeechmaticsResult[]): string {
  const allResults = [...words, ...punctuation].sort((a, b) => a.start_time - b.start_time);

  let text = '';
  for (let i = 0; i < allResults.length; i++) {
    const result = allResults[i];
    const content = result.alternatives?.[0]?.content || '';

    if (result.type === 'punctuation') {
      text += content;
    } else {
      if (text.length > 0 && !text.endsWith(' ')) {
        const lastChar = text[text.length - 1];
        if (!['.', ',', '!', '?', ':', ';', '"', "'", ')'].includes(lastChar)) {
          text += ' ';
        } else if (['.', ',', '!', '?', ':', ';'].includes(lastChar)) {
          text += ' ';
        }
      }
      text += content;
    }
  }

  return text.trim();
}

function buildWordsArray(results: SpeechmaticsResult[]): SpeechmaticsWord[] {
  return results
    .filter((r) => r.type === 'word')
    .map((r) => ({
      content: r.alternatives?.[0]?.content || '',
      start_time: r.start_time,
      end_time: r.end_time,
      confidence: r.alternatives?.[0]?.confidence ?? 1,
      type: 'word' as const,
      language: r.alternatives?.[0]?.language,
    }));
}

export function addTimesInText(words: SpeechmaticsWord[]): string {
  let enhancedText = '';

  words.forEach((word, index) => {
    const timeBetweenNextWord =
      index !== words.length - 1 ? (words[index + 1].start_time - word.end_time).toString() : '';

    enhancedText +=
      word.content.trim() + (timeBetweenNextWord ? `<${timeBetweenNextWord.slice(0, 5)}s>` : '');
  });

  return enhancedText;
}

function parseSpeakerNumber(speakerStr: string): number {
  const match = speakerStr.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

export function splitTooLongSegments(
  segments: SpeechmaticsSegment[],
  maxCharacters: number = 500,
): SpeechmaticsSegment[] {
  const result: SpeechmaticsSegment[] = [];

  for (const segment of segments) {
    if (segment.transcription.length > maxCharacters && segment.words.length > 1) {
      const splitSegments = splitSegmentByWords(segment, maxCharacters);
      result.push(...splitSegments);
    } else {
      result.push(segment);
    }
  }

  return result.map((seg, idx) => ({ ...seg, index: idx }));
}

function splitSegmentByWords(segment: SpeechmaticsSegment, maxCharacters: number): SpeechmaticsSegment[] {
  const chunks: SpeechmaticsSegment[] = [];
  let currentWords: SpeechmaticsWord[] = [];
  let currentLength = 0;

  for (const word of segment.words) {
    const wordLength = word.content.length;

    if (currentLength + wordLength > maxCharacters && currentWords.length > 0) {
      // Create a chunk from current words
      const chunkTranscription = currentWords.map((w) => w.content).join(' ');
      const chunkBegin = currentWords[0].start_time;
      const chunkEnd = currentWords[currentWords.length - 1].end_time;

      chunks.push({
        transcription: chunkTranscription,
        begin: Number(chunkBegin.toFixed(3)),
        end: Number(chunkEnd.toFixed(3)),
        speaker: segment.speaker,
        channel: segment.channel,
        confidence: segment.confidence,
        language: segment.language,
        duration: Number((chunkEnd - chunkBegin).toFixed(3)),
        index: 0, // Will be re-indexed later
        wordsWithSilence: addTimesInText(currentWords),
        words: [...currentWords],
      });

      currentWords = [];
      currentLength = 0;
    }

    currentWords.push(word);
    currentLength += wordLength + 1; // +1 for space
  }

  // Handle remaining words
  if (currentWords.length > 0) {
    const chunkTranscription = currentWords.map((w) => w.content).join(' ');
    const chunkBegin = currentWords[0].start_time;
    const chunkEnd = currentWords[currentWords.length - 1].end_time;

    chunks.push({
      transcription: chunkTranscription,
      begin: Number(chunkBegin.toFixed(3)),
      end: Number(chunkEnd.toFixed(3)),
      speaker: segment.speaker,
      channel: segment.channel,
      confidence: segment.confidence,
      language: segment.language,
      duration: Number((chunkEnd - chunkBegin).toFixed(3)),
      index: 0,
      wordsWithSilence: addTimesInText(currentWords),
      words: currentWords,
    });
  }

  return chunks;
}
