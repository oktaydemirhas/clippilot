# ClipPilot

Upload an educational video. ClipPilot turns it into:

- **HLS streaming** (FFmpeg, 720p max, played with hls.js)
- **AI chapters and a summary**
- **An in-video quiz.** The player pauses at the timestamp the model gave for each question. The code checks that the timestamp is inside the video, not that it is the right moment (see "Known limits").
- **Highlight clips**, cut automatically. The model proposes highlights, a second model call picks and trims them by calling a `cut_clip` tool, and the backend validates every call before FFmpeg runs.

It is a prototype for the SAAT Teknoloji *New Product Developer* role, built around what I know best: five years of making interactive learning video.

## How it works

```
POST /api/videos  ->  202 { id }            (503 when the queue is full, 413 when too large)
                       |
        probe -> transcode to HLS -> extract audio -> LLM analysis -> LLM picks clips -> FFmpeg cuts
                       |
GET  /api/videos/:id/events   (Server-Sent Events: live progress with a percentage)
GET  /api/videos/:id          (job state + result)
GET  /media/:id/hls/...       (playlist + segments)   GET /media/:id/clips/...   (mp4 clips)
```

- **Node 22 + TypeScript (strict) + Fastify.** FFmpeg runs through `spawn` with a timeout and `SIGKILL`, never `execSync`, so an encode does not block the event loop.
- **The LLM sits behind an interface** (`src/llm/provider.ts`). `GeminiProvider` sends the extracted audio to Gemini and gets chapters, quiz and highlights back. `MockProvider` is deterministic and is what most tests use. A fake-SDK test covers `GeminiProvider` itself.
- **Model output is never trusted** (`src/analyze.ts`, `src/schema.ts`). Every answer must pass a zod schema *and* semantic checks (timestamps inside the video, chapters in order, clip lengths sane, no quiz when there is no speech). The JSON Schema generated from the zod schema is also enforced by the Gemini API. A rejected answer goes back to the model together with the rejected JSON and the exact reasons, up to 3 attempts. A provider that throws or returns text that is not JSON counts as a rejected attempt. Failed requests (network, timeout, 429, 5xx) wait with exponential backoff and jitter; a 4xx such as a bad API key fails at once instead of burning three requests. The raw provider error is only logged: it can contain server paths or API response bodies.
- **Tool calls are validated too** (`src/clips.ts`). The model may only call `cut_clip`; its arguments are checked for bounds, length and count before anything reaches FFmpeg. Rejections are reported, and neither a failed cut nor a failed second model call (rate limit, timeout) fails the whole job: the HLS output and the analysis are kept. The second model call only sees the first call's highlight list (not the audio), so it is a re-ranking and trimming step, not an autonomous agent loop. The mock does not simulate function calling.
- **Untrusted uploads.** The file name is never used on disk. FFmpeg and ffprobe run with a protocol whitelist (`file` only) and a demuxer whitelist (MP4/MOV/MKV/WebM/AVI), so an HLS playlist disguised as a video is refused as a format. (FFmpeg already blocks `http` inside a playlist opened from a file by default; the whitelists make that explicit and add the format check.) FFmpeg is told which streams to use (`-map 0:V:0 -map 0:a:0`), because by default it prefers the largest video stream while the resolution cap looks at the first one, and output is cut at the probed duration (`-t`), because a header can claim less than the file holds. The original upload and the extracted audio are deleted when a job ends, partial uploads are removed, and only HLS files and clips with server-generated names are public.
- **Progress bar.** The percentage is real for the FFmpeg transcode (read from `-progress`); the other steps have fixed ranges. While the model thinks the bar waits at 70%, because no honest number exists for that. It never goes backwards and never shows 100 before the job is done. Temporary files are deleted before the final event, so a client that sees "done" also sees them gone.
- **Limits** (`.env.example`): upload size, video length (45 min default), one job at a time with a short queue (503 when full; uploads still streaming in count against it), one file and no text fields per upload, 4K pixel cap, FFmpeg and model-call timeouts, job directories deleted after 24 h (only directories whose name is a job id). The server listens on loopback by default, answers only to loopback `Host` names (DNS rebinding; add yours with `ALLOWED_HOSTS`), and refuses POSTs from another origin.
- **Self-hosted hls.js and a strict CSP**, no inline scripts, model text is only ever rendered with `textContent`.

## Run it

```bash
npm install
cp .env.example .env        # add GEMINI_API_KEY, or set LLM_PROVIDER=mock
npm run dev                 # http://127.0.0.1:3000
```

Docker: `docker compose up --build` (set `GEMINI_API_KEY` in your shell or `.env`). The image uses Debian's patched FFmpeg instead of the bundled binaries.

```bash
npm run lint && npm run typecheck && npm test
```

## What is verified

| Check | Status |
| --- | --- |
| Lint, typecheck, 55 tests | passing locally (Windows, Node 24) |
| Real FFmpeg end to end: upload -> HLS (4 s segments) -> clips with the expected duration, odd-height video, Matroska, no-speech recording, no-audio video (mock LLM) | in the test suite |
| Attacks: literal `..` paths (raw HTTP, not `fetch`), disguised HLS playlist (a local listener receives zero requests), a hidden 4K second video stream, text file claiming `video/mp4`, oversize upload leaves no partial file, queue full -> 503 (also for parallel uploads), foreign `Host` / `Origin` -> 403 | in the test suite |
| Retry policy: backoff, fail-fast on 401, raw provider text kept out of the job record; a failing `planClips` keeps the finished job | in the test suite |
| `GeminiProvider` against a fake SDK: parse failure and empty reply are returned, not thrown; retry prompt contains the previous answer; tool-call mapping | in the test suite |
| HLS playback under the CSP in a real browser (Chromium, mock LLM) | checked manually once |
| Real Gemini (`gemini-3.5-flash-lite`) on three videos | see "Evaluation" |
| GitHub Actions workflow (lint, typecheck, tests, build, `npm audit`) | green on the first push (2026-11-04) |
| `docker build` | green in CI (the image builds; I have not started the container) |
| compose hardening (`read_only`, `cap_drop`) | **never run**: no Docker on my machine |

## Evaluation

Real runs with `gemini-3.5-flash-lite` on 240p Creative Commons YouTube videos (not in this repo). One run per row, so these are findings, not statistics. Times include transcoding. I did not save the raw outputs, so you cannot check these numbers from the repo; `node scripts/eval.mjs <video>...` runs the same measurement against a running server and prints the summary as JSON.

| Video | Length | First run (early version) | Re-run after the fixes below |
| --- | --- | --- | --- |
| Turkish intro to Python (talk) | 2:39 | done, 58 s, 1 attempt, 1 clip | done, 32 s, 2 attempts, 2 clips |
| Turkish Python-grammar demo (screencast, probably no narration) | 5:16 | done, 28 s, but it made a quiz about the audio type | done, 25 s, 1 attempt, no quiz, no clips, summary says "only background music" |
| Turkish course lesson | 16:52 | **failed** after 3 attempts, 202 s: quiz timestamps past the end of the video (`at=1220`, video is 1011 s) | done, 179 s, 2 attempts, 2 clips |

What these runs showed, in the order I found it:

1. Early on, the JSON shape lived only in the prompt. Two of three videos failed with missing `highlights` fields, and the one that passed was generic, in English, with round timestamps for a Turkish video. The API now enforces the JSON Schema generated from the zod schema.
2. The screencast had no speech, and the system made up a quiz anyway. The analysis now carries `hasSpeech`; when it is false the lists must be empty and no clips are cut.
3. On the 16 min video the retry loop only sent the rejection reasons back, not the rejected answer, and it failed three times. It now sends both, and the same video passed on attempt 2. That is one run, so I cannot say the change is the cause.
4. Adding length limits to the zod schema made the live API return a bare `400 INVALID_ARGUMENT` on every request, while all tests still passed (the fake SDK accepts anything). Bisecting against the real API showed Gemini rejects `maxLength` and `maxItems` in `responseJsonSchema`. They are stripped before sending, zod still enforces them, and a test now guards it.

Output varies between runs: the same 2:39 video produced 1 clip in the first run and 2 in the second. I have not measured how often.

## Independent review

Before publishing I had two AI agents review the repo in fresh sessions with no context: a general code and architecture review and a security audit. They found real problems, which I checked and fixed where cheap:

- Fixed and verified: the retry loop did not cover non-JSON or empty replies; no timeouts; no concurrency limit; odd video heights crashed the encoder (reproduced: `height not divisible by 2`); HLS segments were ~10 s instead of 4 s (reproduced); partial uploads and originals were never deleted; no duration or resolution cap; FFmpeg ran with every protocol and demuxer; server paths leaked into error messages; hls.js came from a CDN without integrity checks; no security headers; unvalidated config; one failed cut failed the job.
- Also found: my own earlier traversal test was vacuous (`fetch` normalises `..` before sending), the README claimed the retry covered every bad answer, and the "no speech" and "responseJsonSchema" fixes appear in the first commits although I made them after the first Gemini runs. All three are corrected here.
- Left on purpose, see "Known limits".

A second round on the fixed code (two fresh agents, an Opus general review and a security audit with a git-history secret scan) found more:

- Fixed and verified by a test that fails without the fix: a second, larger video stream bypassed the 4K cap (FFmpeg picked it, the probe did not look at it); parallel uploads all passed the queue check before any was queued; a failing second model call threw away a finished job; the janitor would delete any old entry in `DATA_DIR`, not just job directories.
- Fixed with a test: raw provider errors (server paths, API bodies) reached the job record; every error was retried immediately three times, including a bad API key.
- Fixed without a dedicated test: multipart text fields were buffered in memory; clips were not capped at 720p; the frontend leaked a player per upload, polled forever on a 404, and threw on a non-JSON error; the mock failed videos under 7.5 s; `npm audit` was out of date (`npm audit fix`, no `--force`, now reports 0 for production dependencies); output is cut at the probed duration (`-t`).
- The history scan found no keys, tokens or local paths in any commit.

An AI review is not a human review, and it is not a guarantee.

## Known limits

- **No authentication and no rate limiting.** Anyone who can reach the port can spend CPU and model calls. It listens on loopback by default; behind a reverse proxy you would add auth, TLS and a per-IP limit. There is no cost cap on model calls.
- **Videos are limited to 45 minutes** because the audio is sent inline in one request. Long audio needs chunking with timestamp offsets or the Gemini Files API; not built.
- **Timestamp correctness is not measured.** I check that timestamps are inside the video and ordered, not that a quiz question appears right after the answer was explained. On one video it looked slightly early.
- **Small evaluation**: three videos, one run each, all Turkish. No English, no noisy audio, nothing over 17 minutes.
- Jobs live in memory and are lost on restart; media links are secret UUID URLs that stay valid until the job directory is deleted (24 h).
- Local development uses `ffmpeg-static` and `ffprobe-static`, which ship old builds (ffprobe 4.0.2 from 2018). The Docker image uses Debian's FFmpeg.
- CI actions and Docker base images are pinned to tags, not commit SHAs or digests, and the checkout step keeps its token. `npm audit --omit=dev` reports no findings today; that can change.
- A model call that works with inline audio can still hit the API's request size limit: 45 minutes of audio is about 11 MB, the cap in code is 14 MiB, and base64 adds a third.
- RTMP/live ingest, RAG over a library of videos, multiple HLS renditions: out of scope.

## Working with AI

I built this with an AI coding assistant and treated its output as untrusted. What the checks caught:

- `tsc` rejected my first `ffmpeg-static` import: its type declaration is a namespace, but at runtime it is a path string. Fixed with an explicit, commented cast.
- On the first real Gemini run the model's answer was **rejected by the schema** (`highlights.0.reason` missing). The retry loop sent the reason back and the second answer validated.
- A test the assistant generated asserted a list that silently ignored its last element; another claimed to test path traversal but `fetch` had already removed the `..`. Both were rewritten.
- The assistant's own README claimed more than the code did (retry "up to 3 attempts" for every bad answer, "transcript-based", "agentic"). The review found it and the wording above is what remains true.
- A schema change passed every test and the live API still returned 400. Mocks and fakes cannot tell you what a real service rejects, so every change to a model call now gets one real run.

## Git history

The commits were written after the code, as logical groups, not in the order things happened. The order in which problems were found is in "Evaluation".
