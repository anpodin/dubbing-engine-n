# Dubbing Engine (Bun + TypeScript) — Codex Instructions

## Project context

This repo is a CLI dubbing pipeline that takes **one** audio/video file from `input/` and produces dubbed output in
`output/`.

Core flow (see `src/core/index.ts`):

1. Split video ↔ audio (`src/ffmpeg/*`)
2. Transcribe + (optional) diarize + summarize (Speechmatics API or local Whisper, `src/transcription/transcriber.ts`)
3. Translate segments with context (OpenAI, `src/transcription/textTranslator.ts`, prompts in `src/llm/prompt-builder.ts`)
4. Separate background vs vocals (Lalal.ai API or local Demucs + ElevenLabs isolation, `src/separator/`)
5. Clone speaker voices + generate TTS (ElevenLabs, `src/elevenlabs/elevenlabs.ts`, `src/speech/speechGenerator.ts`)
6. SmartSync timing adaptation (OpenAI, `src/smart-sync/adaptation.ts`)
7. Assemble final audio/video + subtitles + optional lipsync (FFmpeg + Sync.so + optional AWS S3, `src/subtitles/*`,
   `src/lipsync/lipsync.ts`)

## How to run (human workflow)

- Put a single file in `input/` (supported extensions are in `src/utils/constants.ts`).
- Create `.env` from `.env.example` and fill in API keys.
- Run `./start.sh` (interactive). It exports runtime params then runs `bun src/core/index.ts`.

## Working agreements for Codex

### Safety / cost / network

- Do **not** run `./start.sh` or `bun src/core/index.ts` unless I explicitly ask; they call paid external APIs and can be
  slow.
- Always ask before running anything that may hit the network (OpenAI/Speechmatics/ElevenLabs/Lalal.ai/Sync.so/AWS, or
  downloading Whisper models) or process large media with `ffmpeg`.
- Never print, exfiltrate, or “helpfully” rewrite real secrets. Don’t edit `.env`. If an env var needs documenting, update
  `.env.example` and/or `README.md` only.

### Repo conventions

- Runtime is Bun + ESM (`package.json` has `"type": "module"`). Any Node-config `.js` file is treated as ESM; use `.cjs`
  for CommonJS configs.
- Prefer strict TypeScript and existing types in `src/types/*.d.ts`. Keep changes type-safe; avoid `any` unless necessary.
- Prefer `fs/promises` and repo helpers: `pathExists`, `ensureDir`, `safeUnlink` (`src/utils/fsUtils.ts`).
- For FFmpeg/FFprobe, use wrappers in `src/ffmpeg/ffmpeg-runner.ts` (consistent errors/timeouts).
- Preserve concurrency/rate-limit knobs in `src/utils/config.ts` (e.g., `maxSimultaneousFetchOpenAI`,
  `maxSimultaneousFetchElevenLabs`).
- Prompt edits are high-risk: if you change anything in `src/llm/prompt-builder.ts`, preserve the required “return only the
  translated/reformulated text” contract because downstream code assumes plain strings.
- Only add comments when it's really necessary.

### Local verification (offline-safe)

- Typecheck: `bunx tsc -p tsconfig.json`
- Format: `bunx prettier --check "src/**/*.ts"` (or `--write`)
- Lint: currently not reliable because `.eslintrc.js` is CommonJS in an ESM package; fix by migrating to
  `eslint.config.js` or renaming to `.eslintrc.cjs` before expecting `eslint` to run.

### Git hygiene

- Avoid adding new large binaries (media files). Keep generated outputs in `output/` and temp artifacts in
  `temporary-files/` only.
- If dependencies change, update `package.json` + `bun.lockb` together, and ask before adding new production deps.
