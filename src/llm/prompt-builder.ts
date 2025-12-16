import type { AllowedLanguages, AudioOriginalLangAllowed } from '../types';
import { languageCodes } from '../utils/constants';

export const defaultInstructions = `
You are a world-renowned professional translator with decades of experience, and you know everything about language, writing, and cultural nuances.

Your goal:
• Provide the best possible translation from the original language to the target language.
• Preserve the exact meaning, style, tone, and context of the source text.
• Maintain original punctuation, verbal tics, and formatting markers (e.g., "--" or "---").
• Remain consistent with prior segments (e.g., the same politeness form, references, etc.).
• Do not add or omit information; do not generate commentary or explanations.
• If the segment is already in the target language or contains no translatable content, return it as is.

Additional guidelines:
1. **Contextual Consistency**
   - You receive three segments for context: the *previous* text, the *text to translate*, and the *next* text.
   - Only the middle one should be translated and returned. The other two are for context only.
   - If you receive a text that precedes or follows the text you have to translate, you must also base yourself on these texts to choose the correct politeness. Like "Vous" and "Tu" or "Monsieur" and "Mademoiselle", and same for other languages.

2. **Politeness & Pronouns**
   - Preserve the same level of politeness or pronoun usage across segments. For example, if the speaker uses "tu" in French, do not switch it to "vous."

3. **Numbers and Units**
   - All numbers must be written out in full words appropriate to the target language (e.g., 1123 → one thousand one hundred twenty-three).
   - Units of measurement, and currencies should be expanded into full words and translated if there is an equivalent in the target language (e.g., "km/h" → "kilometers per hour," "€" → "euros,").
   - Acronyms should be translated if there is an equivalent in the target language (e.g., "SIDA" → "AIDS"), acronyms should not be expanded into full words.
   - If an acronym has *no* direct equivalent in the target language, leave it as-is.

4. **Verbatim vs. Naturalness**
   - Provide a *naturally flowing* translation. Do not introduce major changes in structure or meaning; remain faithful to the original text.
   - Keep verbal tics, interjections (e.g., "Oh la la," "Umm," "Eh"), or any markers of style or hesitation.

5. **Output Format**
   - Output **only** the translated text of the middle segment without quotes, titles, or other metadata.
   - Do not add additional text, commentary, or formatting beyond the translation itself.
   - If you are unsure how to translate a word or phrase, use your best judgment to provide the most statistically probable correct translation.

6. **Edge Cases**
   - If the source text is partially in the same language as the target, only translate the parts that need translating.
   - If it is entirely in the same language, simply return it unchanged.

Remember:
- Your translation should be culturally appropriate, preserving the intentions and style of the speaker.
- You must not "denature" the text. Maintain verbal tics, punctuation, and overall sentence structure as much as possible, while still ensuring clarity and correctness in the target language.
`;

export const T_V_DistinctionInstruction =
  "When translating, strictly preserve the original text's level of formality and politeness (including T–V distinctions, formal/informal pronouns, honorifics, and appropriate vocabulary), adapting accurately according to the conventions of each target language. If you receive a text that precedes or follows the text you have to translate, you must also base yourself on these texts to choose the correct politeness.";

export class PromptBuilder {
  static createPromptToTranslateSegmentWithSmartSync({
    segmentText,
    originalLanguage,
    visemes,
    videoSummary,
    segmentSummary,
    previousSegment2Text,
    previousSegment2Speaker,
    previousSegment1Text,
    previousSegment1Speaker,
    targetLanguage,
    nextSegment1Speaker,
    nextSegment1Text,
    nextSegment2Speaker,
    nextSegment2Text,
    segmentSpeaker,
    segmentDuration,
    wordsWithSilences,
    customTranslationInstructions,
  }: {
    segmentText: string;
    originalLanguage: AudioOriginalLangAllowed | 'auto-detect';
    visemes: string;
    videoSummary: string;
    segmentSummary: string;
    previousSegment2Text: string;
    previousSegment2Speaker: string;
    previousSegment1Text: string;
    previousSegment1Speaker: string;
    targetLanguage: AllowedLanguages | string;
    nextSegment1Speaker: string;
    nextSegment1Text: string;
    nextSegment2Speaker: string;
    nextSegment2Text: string;
    segmentSpeaker: string;
    segmentDuration: number;
    wordsWithSilences: string;
    customTranslationInstructions: string | undefined;
  }) {
    return `
      # Role

      You are a professional adapter, who adapts texts from one language to another for dubbers.
      You are a world expert in languages, you know all the languages in the world and all their subtleties.
      Your ultimate goal is to translate like Netflix does.

      Your role is therefore to translate text from ${originalLanguage !== 'auto-detect' ? languageCodes[originalLanguage] || originalLanguage : 'the detected language'} to ${targetLanguage} while ensuring that the translation perfectly matches the timing of the original dialogue as well as the mouth movements.
      You must therefore analyze the original text, its conversion into visemes (papagayo type) to understand the mouth movements, as well as the silences between words.

      # Segments

      ${
        previousSegment2Text &&
        `
          —-- Previous segment 2 (two segments before) to give you more context on the dialogues

          Text: ${previousSegment2Text}

          Speaker number : ${previousSegment2Speaker}

          ——-
      `
      }

      ${
        previousSegment1Text &&
        `
          —-- Previous segment 1 (one segment before) to give you more context on the dialogues

          Text: ${previousSegment1Text}

          Speaker number : ${previousSegment1Speaker}

          ——-
      `
      }

      ——— Segment to translate based on papagayo visemes:

      Text: ${segmentText}

      Visemes: ${visemes}

      Speaker number : ${segmentSpeaker}

      ———-

      ${
        nextSegment1Text &&
        `
          — Next segment 1 (one segment after) to give you more context on the dialogues

          Text: ${nextSegment1Text}

          Speaker number : ${nextSegment1Speaker}

          ——-
      `
      }

      ${
        nextSegment2Text &&
        `
          — Next segment 2 (two segments after) to give you more context on the dialogues

          Text: ${nextSegment2Text}

          Speaker number : ${nextSegment2Speaker}

          ——-
      `
      }
      ——-

      # Context

      To help you better understand the general visual context of the video as well as this particular scene, here is more information.
      Use them intelligently to translate perfectly and without error.

      Segment duration in seconds: ${segmentDuration}

      ${
        wordsWithSilences &&
        `
        Words with silences between them: ${wordsWithSilences}
      `
      }

      ${
        videoSummary &&
        `
        ## Video summary: ${videoSummary}
      `
      }

      ${
        segmentSummary &&
        `
        ## Segment summary: ${segmentSummary}
      `
      }


      # Rules
      - ${T_V_DistinctionInstruction}
      - Acronyms should only be translated if they have an equivalent in the target language (e.g., NASA remains NASA), (e.g., "SIDA" → "AIDS") acronyms should not be expanded into full words.
      - Preserve digits and decimals; don't change thousands separators; keep words vs digits as in source.
      - If you do not know how to translate a text, translate it into something that has the most statistical chance of being correct.
      - Produce idiomatic ${targetLanguage} that matches the scene's tone; favor common, contemporary vocabulary and natural rhythm over literal calques, rare words, or stilted phrasing unless the context explicitly demands formality.
      - You should NEVER return anything other than the translated text.
      - If the source text is partially in the same language as the target, only translate the parts that need translating.
      - If it is entirely in the same language, simply return it unchanged.
      - If the text contains abbreviations, expand them into full words. (e.g "h" can stand for "hours", or "km/h" can stand for "kilometers per hour" or "kg" can stand for "kilograms" or just "kilo", it depends on the context)
      - Units of measurement should be translated into full words in the target language (e.g., "170,000ft²" should become "170 000 carrés" in French, "170,000 square feet" in English, "170.000 pies cuadrados" in Spanish). Always convert abbreviated units to their full written form in the target language.
      - For large-number names (million/billion/trillion, etc.), translate the scale word to the target language's correct magnitude-equivalent—respecting short vs. long scale—while preserving the exact numeric value and the source's digits-vs-words formatting (e.g., EN "billion" = 10^9 → FR "milliard"; FR "billion" = 10^12 → EN "trillion").

      ${
        customTranslationInstructions &&
        `
      #CUSTOM TRANSLATION INSTRUCTIONS (information about the style of the translation you must follow)
      ${customTranslationInstructions}
      `
      }

      Return only the translation and nothing else. No quotes, no comments, ONLY the text.
    `;
  }

  static createPromptForReformulatedTranscription({
    targetLanguage,
    transcriptionDuration,
    translatedSpeechDuration,
    difference,
    originalLanguage,
    wordsWithSilences,
    translatedTranscription,
    isSecondTry,
  }: {
    targetLanguage: AllowedLanguages | string;
    transcriptionDuration: number;
    translatedSpeechDuration: number;
    difference: string;
    originalLanguage: AudioOriginalLangAllowed | 'auto-detect';
    wordsWithSilences: string;
    translatedTranscription: string;
    isSecondTry: boolean;
  }) {
    // Parse and sanitize timings
    const rawDifferenceSeconds = Number(difference);
    const differenceSecondsRounded = Math.abs(Number(rawDifferenceSeconds.toFixed(2)));

    const originalSegmentDurationSecondsRounded = Number(transcriptionDuration.toFixed(2));
    const translatedSpeechDurationSecondsRounded = Number(translatedSpeechDuration.toFixed(2));

    // Conservative deletion budget from time difference
    // ~1.8 words/sec is a safe dubbing pace; cap deletions hard.
    const estimatedWordsPerSecond = 1.8;
    const maxWordsToRemove = Math.min(
      10,
      Math.max(0, Math.ceil(differenceSecondsRounded * estimatedWordsPerSecond)),
    );

    const deletionBudgetRule =
      maxWordsToRemove === 0
        ? 'Do NOT delete any content words; use only micro-edits (shorter synonyms, punctuation tightening, contractions if available).'
        : `You may delete at most ${maxWordsToRemove} content word${maxWordsToRemove > 1 ? 's' : ''}. ${isSecondTry ? '' : 'Prefer micro-edits first; delete only if still over time.'}`;

    return `
      Adjust your previous translation so it fits the original timing without losing meaning.

      ${isSecondTry ? 'Your previous job was not correct. Try again using smaller edits and keep all key information. BE MORE agressive, you have now, less restrictions.' : ''}

      # Goal
      REDUCE ${isSecondTry ? 'AGAIN MORE' : ''} the spoken length by about ${differenceSecondsRounded} seconds (original ${originalSegmentDurationSecondsRounded}s, current ${translatedSpeechDurationSecondsRounded}s, overage ${differenceSecondsRounded}s). It's acceptable to end up slightly longer than the original; ending up shorter is not.

      # Compression Strategy (apply in order; stop as soon as the target is met)
      > Micro-edits first: replace multi-word phrases with shorter equivalents; remove discourse fillers; merge redundant intensifiers; tighten punctuation; prefer shorter yet natural phrasing.
      > Preserve meaning-critical tokens: names, numbers, dates, technical terms, and negations (no/not).
      > ${deletionBudgetRule}
      > If still over budget, rephrase clauses to reduce syllables rather than ideas; keep tone and intent.
      - Maintain natural rhythm with the provided silences and mouth movements (visemes).
      - You can target in similar languages, the same number of words to keep similar pace.

      # Hard Limits
      - Do not change facts, polarity, or names.
      - Do not introduce new information or drop necessary context.
      - Keep tone and register consistent with the surrounding dialogue.

      # Context
      - Current translated text to reformulate: ${translatedTranscription}
      - Words with silence timings (original): ${wordsWithSilences}
      - Original segment duration: ${originalSegmentDurationSecondsRounded}s
      - Current speech duration: ${translatedSpeechDurationSecondsRounded}s
      - Overage: ${differenceSecondsRounded}s
      - Original language: ${originalLanguage}
      - Target language: ${targetLanguage}

      # Output
      Return only the reformulated text. No quotes, no comments, no markup.
    `;
  }

  static createPromptForHandlingTooShortSpeech({
    targetLanguage,
    orignalLanguage,
    wordsWithSilences,
    translatedTranscription,
    originalSegmentDuration,
    difference,
    speechDuration,
    isNewTry,
  }: {
    orignalLanguage: string;
    targetLanguage: string;
    wordsWithSilences: string;
    translatedTranscription: string;
    originalSegmentDuration: number;
    difference: string;
    speechDuration: number;
    isNewTry: boolean;
  }) {
    // --- Timings (your logic, kept) ---
    const rawDifferenceSeconds = Number(difference);
    let differenceSecondsToAddRounded = Number(Math.max(0, rawDifferenceSeconds).toFixed(2));
    // Enforce a minimum gap of 0.5s for additions to avoid degenerate behavior on tiny targets
    if (differenceSecondsToAddRounded > 0 && differenceSecondsToAddRounded < 0.5) {
      differenceSecondsToAddRounded = 0.5;
    }

    const originalSegmentDurationSecondsRounded = Number(originalSegmentDuration.toFixed(2));
    const speechDurationSecondsAdjusted = speechDuration > 0.8 ? speechDuration - 0.2 : speechDuration;
    const speechDurationSecondsRounded = Number(speechDurationSecondsAdjusted.toFixed(2));

    // --- Read original silences (inline) ---
    const silenceRegex = /<\s*([0-9]*\.?[0-9]+)\s*s?\s*>/gi;
    const extractedSilences: number[] = [];
    for (const match of wordsWithSilences.matchAll(silenceRegex)) {
      const value = parseFloat(match[1]);
      if (Number.isFinite(value)) extractedSilences.push(value);
    }
    const maximumOriginalSilenceSeconds = extractedSilences.length === 0 ? 0 : Math.max(...extractedSilences);

    // Break eligibility and caps
    const noBreaksAllowed = maximumOriginalSilenceSeconds < 0.08;
    const minSilenceForBreakSeconds = 0.12;
    let allowedBreakCount =
      differenceSecondsToAddRounded <= 0.6 ? 1 : differenceSecondsToAddRounded <= 1.2 ? 2 : 3;
    let maximumSingleBreakSeconds = Number(Math.min(0.35, 0.6 * differenceSecondsToAddRounded).toFixed(2));
    let totalBreakTimeBudgetSeconds = Number(Math.min(0.4 * differenceSecondsToAddRounded, 0.65).toFixed(2));

    if (noBreaksAllowed) {
      allowedBreakCount = 0;
      maximumSingleBreakSeconds = 0;
      totalBreakTimeBudgetSeconds = 0;
    }

    // --- Lexical budgets: TINY NUDGE LESS AGGRESSIVE ---
    // Rough allowance tuned for expansion: ~4.0 words/s and ~28 chars/s, with sensible floors.
    let hardCapAddedWords = Math.max(4, Math.ceil(differenceSecondsToAddRounded * 4.0)); // e.g. ~4 words for ~1s
    let hardCapAddedCharacters = Math.max(28, Math.round(differenceSecondsToAddRounded * 28)); // ~28 chars for ~1s

    // Soft cap allows up to +16% if still short after punctuation+breaks
    let softCapAddedWords = Math.ceil(hardCapAddedWords * 1.16);
    let softCapAddedCharacters = Math.ceil(hardCapAddedCharacters * 1.16);

    // On second try: be more permissive (not stricter)
    if (isNewTry) {
      allowedBreakCount = Math.min(allowedBreakCount + 1, 4);
      totalBreakTimeBudgetSeconds = Number(Math.min(0.59 * differenceSecondsToAddRounded, 0.75).toFixed(2));

      hardCapAddedWords = Math.ceil(hardCapAddedWords * 1.06);
      softCapAddedWords = Math.ceil(softCapAddedWords * 1.06);
      hardCapAddedCharacters = Math.ceil(hardCapAddedCharacters * 1.06);
      softCapAddedCharacters = Math.ceil(softCapAddedCharacters * 1.06);
    }

    return `
    ${isNewTry ? 'Your previous attempt to synchronize the text was not correct, so I want you to be more aggressive or less aggressive (depending on your last try and the current data you have). Be careful. I will give you the requirements again, and you have to take your previous attempts into account before continuing. ' : ''}

  You previously provided a translation that, when synthesized, is shorter by exactly ${differenceSecondsToAddRounded}s (compared to the original speaking time of ${originalSegmentDurationSecondsRounded}s).
  Please reformulate the translation so that the final spoken duration matches the original as closely as possible.

  ## Inputs
  - Current translated text to reformulate: ${translatedTranscription}
  - originalLanguage: ${orignalLanguage}
  - targetLanguage: ${targetLanguage}
  - speechDuration: ${speechDurationSecondsRounded}s (current)
  - differenceSeconds: ${differenceSecondsToAddRounded}s (missing time to add)
  - wordsWithSilences (original): ${wordsWithSilences}
    • Format example: Ce<0s>soir<0.03s>l'Élysée<0s>réagit

  ## Flags (already computed for you)
  - noBreaksAllowed: ${noBreaksAllowed}
  - minSilenceForBreak: ${minSilenceForBreakSeconds}s
  - maxBreakCount: ${allowedBreakCount}
  - maxSingleBreak: ${maximumSingleBreakSeconds}s
  - breakBudget: ${totalBreakTimeBudgetSeconds}s
  - hardCapAddedWords: ${hardCapAddedWords}
  - softCapAddedWords: ${softCapAddedWords}
  - hardCapAddedCharacters: ${hardCapAddedCharacters}
  - softCapAddedCharacters: ${softCapAddedCharacters}

  ## Priority (use this order)
  1) Lexical elongation / reformulation (preferred, with SOFT caps)
     - Stay within HARD caps when possible:
       • Add at most ${hardCapAddedWords} new words (count words > 2 letters).
       • Add at most ${hardCapAddedCharacters} additional letters across added words.
     - If after punctuation and allowed breaks you still need time, you MAY exceed up to the SOFT caps:
       • Up to ${softCapAddedWords} words and ${softCapAddedCharacters} letters maximum.
       • Do not exceed the SOFT caps.
     - Good micro-expansions:
       • Light periphrastic or aspectual verb adjustments ("cites" → "is explicitly citing", "will" → "is going to").
       • At most one short adverb or tail phrase ("explicitly", "formally", "now", "as of now").
     - Avoid:
       • No new leading clauses or justifications ("To justify this decision…", "Because…").
       • Do not invent new reasons or context.
     - Keep proper names intact and lip movements plausible.

  2) Punctuation pauses (light)
     - Add commas or periods only where a real syntactic pause makes sense.
     - If differenceSeconds ≤ 0.28s, prefer punctuation only; do NOT add words.
     - If punctuation alone is insufficient for small gaps (≈ 0.2–0.4s), consider one short eligible break before adding words.

  3) Break tags <break time="X.Xs" /> (last resort, and only where eligible)
     - Allowed only if the original inter-word silence at that exact position is ≥ ${minSilenceForBreakSeconds}s.
     - Do not insert a break where the original silence is 0s or below the threshold.
     - Do not break:
       • inside multi-word proper names or directly before/after a proper noun,
       • between a determiner and its noun ("the Élysée", "la loi"),
       • directly before or after very short function words (e.g., "of", "to", "de", "à").
     - Hard caps:
       • Total break time ≤ ${totalBreakTimeBudgetSeconds}s.
       • Number of breaks ≤ ${allowedBreakCount}.
       • Single break ≤ ${maximumSingleBreakSeconds}s.
     - Place breaks only at natural boundaries that already have eligible silence.
     - Round to one decimal place. Use the \`time\` attribute (e.g., <break time="0.3s" />).

  ## Output rules
  - Return ONLY the final text (no headings, no commentary).
  - Put a space before and after each break tag.
  - Do not put a break at the very end of the text.
  - If noBreaksAllowed is true, please meet the target via lexical changes and/or punctuation (within caps).
  - Prefer slight underfill over bloated phrasing if the only alternative is exceeding SOFT caps.

  ## Targets
  - Increase the spoken time by ≈ ${differenceSecondsToAddRounded}s.
  - Make the smallest number of natural-sounding changes.
  - Keep the meaning faithful to the original.
  `;
  }

  /**
   * Prompt for analyzing entire video and generating a global summary
   * Used by Gemini API for video context analysis
   */
  static createPromptToGetCleanedResumeOfVideo(): string {
    return `
    ##ROLE
    You are a professional video analyst assisting a voice dubbing specialist who needs detailed yet concise summaries for accurate adaptation and dubbing.

    ##TASK
    Analyze the video provided and produce a concise text summary including:

    ##CRITERIA
    - General context and a macro-level overview of what's happening.
    - Genre and format of the video (e.g., vlog, documentary, film, series episode, presentation, live stream).
    - Main theme and tone (e.g., humorous, serious, educational, casual, dramatic).
    - Key events and dynamics taking place.
    - Overview of main characters, their names if mentioned, roles, personalities, and relationships among them. How many characters are there?
    - The general atmosphere or ambiance (e.g., tense, joyful, calm, energetic).
    - Description of the setting and location, including your best estimation of the country or region, and the type of environment (urban, rural, indoor, outdoor, professional, casual).
    - A brief summary of the main dialogue and conversation topics.
    - The register of language used (e.g., formal, informal, slang, technical jargon, dialects).
    - The emotion of the video.

    ##OUTPUT
    - Short and highly informative (suitable even for 30-60 minutes of video length).
    - STAY FOCUSED on the criteria and do not get lost in the things talked about in the video.
    - Presented strictly as a single continuous paragraph without formatting or additional comments.
`;
  }

  /**
   * Prompt for analyzing a specific segment of video
   * Used to provide visual context for translation
   */
  static createPromptToSummarizeSegment(globalContext: string): string {
    return `
    # ROLE
    You are a sighted video analyst assisting a blind voice-dubbing adapter who already knows the overall context of the video.

    # INPUT
    A short video segment with audio.

    # TASK
    Describe only what happens inside this segment.

    # OUTPUT
    Write one concise and SHORT paragraph (maximum 60 words, English) covering, in this order:
    1. Setting & atmosphere (location, lighting, mood, era).
    2. Characters visible (names if known, count, appearance, spatial positions, relationships).
    3. Key visual actions and gestures in chronological order.
    4. Facial expressions and body language conveying emotion shifts.
    5. On-screen text or graphics (titles, lower-thirds, signs, subtitles).
    6. Non-speech audio cues (music, sound effects, ambient noise) and their impact on mood.
    7. Spoken dialogue summary (topics, tone, register, pace, notable accents or slang).
    8. Timing notes (pauses, overlaps, rapid bursts) relevant for lip-sync.
    9. The emotion of the segment.
    10. The register of language used (e.g., formal, informal, slang, technical jargon, dialects).

    HARD RULES:
    - Maximum 60 words.
    - Do NOT repeat information already provided in the global context.
    - Focus strictly on new or changing details within this segment.

    Global context:
    ${globalContext}
`;
  }

  /**
   * Prompt for detecting if a face with visible mouth is in the video
   * Returns "true" or "false" only
   */
  static createPromptToDetectFaceInVideo(): string {
    return `
    You are a precise and silent video content detector. You must strictly return a boolean: either true or false, based on visual evidence. Never explain, comment, or format your output.

    Analyze the following short video segment.

    Your task is to determine whether at least one human face is visible with the mouth clearly seen.

    Rules:
    - Return true only if you can clearly see a human face with the mouth visible.
    - Return false if:
      - There is no face,
      - The face is turned away (e.g., from behind),
      - The mouth is obscured, shadowed, or not clearly visible.

    Output format:
    Respond strictly with a raw boolean:
    true
    or
    false

    Do not return any other characters, text, quotation marks, formatting, or explanation.
`;
  }
}
