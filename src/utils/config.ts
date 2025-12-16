import type { AllowedLanguages } from '../types';

export const threshold = 0.7; // 0.8 seconds
export const maxCharactersPerSegment = 350;
export const maxCharactersPerSegmentForNonLatinScriptLanguages = 175;
export const maxSimultaneousFetchElevenLabs = 1;
export const maxSimultaneousFetchOpenAI = process.env.NODE_ENV === 'production' ? 4 : 10;
export const silenceBetweenSegmentConsideredAsPause = 0.5;

export const specialLanguagesWithSpecialCharacters: AllowedLanguages[] = ['mandarin', 'japanese', 'korean'];

// Video analysis configuration (Gemini API)
export const maxVideoDurationForSingleAnalysisMinutes = 25;
export const maxConcurrentGeminiChunkAnalysis = 3;
export const geminiFileUploadThresholdMB = 30;
export const maxSimultaneousFetchGemini = 3;
export const segmentAnalysisBatchSize = 10;

// SmartSync timestamp adjustment configuration
export const minGapForTimestampExtension = 0.15; // seconds
export const maxTimestampExtensionWithFace = 0.15; // seconds (conservative when face visible)
export const maxTimestampExtensionNoFace = 0.5; // seconds (more flexibility when no face)
