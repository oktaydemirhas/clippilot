# ClipPilot

Upload an educational video. ClipPilot turns it into:

- **HLS streaming** (FFmpeg, 720p max, played with hls.js)
- **AI chapters and summary**
- **An in-video quiz**: the player pauses at the right second and asks a question about what was just explained
- **Highlight clips**, cut automatically: the model decides what to cut by *calling a tool*, and the backend validates every call before FFmpeg runs

I built it as a prototype for the SAAT Teknoloji *New Product Developer* role, around what I know best: five years of making interactive learning video (Cinema8).

## How it works

```
POST /api/videos  ->  202 { id }
                       |
        probe -> transcode to HLS -> extract audio -> LLM analysis -> LLM picks clips -> FFmpeg cuts
                       |
GET  /api/videos/:id/events   (Server-Sent Events: live progress)
GET  /api/videos/:id          (job state + result)
GET  /media/:id/hls/...       (playlist + segments)   GET /media/:id/clips/...   (mp4 clips)
```

- **Node 22 + TypeScript (strict) + Fastify.** FFmpeg runs through `spawn`, never `execSync`, so a long encode does not block other requests.
- **The LLM sits behind an interface** (`src/llm/provider.ts`). `GeminiProvider` sends the extracted audio to Gemini and gets chapters, quiz and highlights back. `MockProvider` is deterministic and is what the tests use.
- **Model output is never trusted** (`src/analyze.ts`, `src/schema.ts`). Every answer must pass a zod schema *and* semantic checks (timestamps inside the video, chapters in order, clip lengths sane). A rejected answer goes back to the model with the exact reasons, up to 3 attempts.
- **Tool calls are validated too** (`src/clips.ts`). The model may only call `cut_clip`; its arguments are checked for bounds, length and count before anything reaches FFmpeg. Rejections are reported, not silently dropped.
- **Only HLS output and clips are public.** The original upload and the extracted audio cannot be fetched (tested).

## Run it

```bash
npm install
cp .env.example .env        # add GEMINI_API_KEY, or set LLM_PROVIDER=mock
npm run dev                 # http://localhost:3000
```

Docker: `docker compose up --build` (set `GEMINI_API_KEY` in your shell or `.env`).

```bash
npm run lint && npm run typecheck && npm test
```

## What is verified

| Check | Status |
| --- | --- |
| Lint, typecheck, 14 tests | passing |
| Real FFmpeg end to end: upload -> HLS playlist and segments -> clips with the expected duration (mock LLM) | passing, in the test suite |
| SSE progress, 415 on non-video, 404 on unknown id, failure message for a video with no audio | passing, in the test suite |
| HLS playback and quiz pause in a real browser | checked manually (Chromium, mock LLM) |
| Real Gemini (`gemini-3.5-flash-lite`) on a 63 s spoken lesson: transcript-based chapters, quiz, function-calling clip cut, clip file probed at the expected 47 s | passing in one manual run (see "Evaluation" for what is still thin) |
| `docker build` | **not yet run** locally (no Docker on my dev machine); runs in CI |

## Evaluation

Real runs with `gemini-3.5-flash-lite`, 240p Creative Commons YouTube videos (not included in this repo). Small sample, one run each, so read these as findings, not statistics.

| Video | Length | Result | Notes |
| --- | --- | --- | --- |
| Turkish intro to Python (talk) | 2:39 | done, 1st answer valid, 58 s | Turkish chapters, quiz and summary, content-specific. Two highlights were proposed and the clip planner chose to cut one (no tool call was rejected). |
| Turkish Python-grammar demo (screencast, probably no narration) | 5:16 | done, 1st answer valid, 28 s | Model reported "instrumental, no speech". I did not listen to confirm. It still produced a one-question quiz about the audio type, which a product should refuse instead. Fixed: see "no speech" below. |
| Turkish course lesson | 16:52 | **failed** after 3 attempts, 202 s | The model kept returning quiz timestamps past the end of the video (`at=1220`, video is 1011 s). The semantic check caught it every time; the model never fixed it. |

What these runs changed:

- Before: the JSON shape lived only in the prompt. 2 of 3 videos failed with missing `highlights` fields, and the one that passed was generic, in English, with round timestamps for a Turkish video. After: the JSON Schema generated from the zod schema is enforced by the API (`responseJsonSchema`), and the same short videos validated on the first try.
- Likely fix for the long-audio drift: analyse the audio in chunks of a few minutes and merge with offsets. Not built yet.
- No speech: the analysis now carries `hasSpeech`. When it is false, chapters, quiz and highlights must be empty (checked, and the reasons are fed back on retry) and no clips are cut. Re-run on the screencast above: 33 s, no quiz, no clips, summary says "only music".
- Output varies between runs. The same 2:39 video took 1 attempt and cut 1 clip in the first run, then 2 attempts and 2 clips in the second. I have not measured how often this happens.
- Open problem: timestamps drift on long audio (see the 16 min row).

## Working with AI

I built this with an AI coding assistant and treated its output as untrusted. Things the checks caught while building:

- `tsc` rejected my first `ffmpeg-static` import: its type declaration is a namespace, but at runtime it is a path string. Fixed with an explicit, commented cast.
- On the first real Gemini run the model's first answer was **rejected by the schema** (`highlights.0.reason` missing). The retry loop sent that exact reason back and the second answer validated. This is the case the mocks were written to cover, and it happened for real.
- A test I generated asserted a list that silently ignored its last element. I rewrote it so every expectation matches a real case.

_Add your own: anything else that went wrong and how you caught it._

## Not in scope (on purpose)

RTMP/live ingest, RAG over a library of videos, auth, a job queue with persistence (jobs live in memory), multiple HLS renditions. Each is a clear next step, none is needed to show the core idea.
