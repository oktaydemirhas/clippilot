# ClipPilot: decisions and lessons

## State (2026-11-04)
- Lint, typecheck, build and 51 tests pass locally. A second review round (Opus + security audit) was fixed on top of the first push; see the README "Independent review". Real FFmpeg end-to-end tests run with a mock LLM; `GeminiProvider` is tested against a fake SDK.
- Real Gemini (`gemini-3.5-flash-lite`) runs on three Turkish videos (2:39, 5:16 no speech, 16:52) all finish after the hardening round. One run each, see the README "Evaluation".
- CI (lint, typecheck, tests, build, audit) and `docker build` were green on the first push, 2026-11-04. The container itself and the compose hardening have never been started.
- Not done: English or noisy audio, videos over 17 min, any measurement of timestamp correctness.

## Decisions
- LLM behind an interface; Gemini gets the extracted mono mp3 inline. Mock provider for tests.
- Never trust model output: zod schema (also enforced by the API as a JSON Schema) + semantic checks + retry (max 3) that sends back the rejected answer and the reasons. Provider errors and non-JSON replies count as rejected attempts. Tool-call args are re-validated before FFmpeg.
- Untrusted uploads: server-chosen file name, `-protocol_whitelist file` and `-format_whitelist` on every FFmpeg/ffprobe input, container allowlist after probing, originals deleted after the job.
- Loopback by default, one job at a time, 45 min cap, job TTL 24 h. No auth or rate limit: documented as a known limit.
- Docker image uses Debian's FFmpeg because `ffprobe-static` is a 2018 build.
- Out of scope: RTMP, RAG, auth, persistent queue, multi-rendition HLS, chunked analysis of long audio.

## Lessons
- `ffmpeg-static` types are a namespace but the runtime value is a path string; cast explicitly.
- `.env` is not loaded by Node on its own: scripts use `--env-file-if-exists=.env` (Node >= 22.9).
- A fake SDK in tests accepts anything. Adding `maxLength`/`maxItems` to the zod schema passed every test and made the live Gemini API return 400. Run one real call after any change to a model request.
- libx264 with yuv420p fails on odd heights (`scale=-2:min(720,ih)` kept an odd `ih`); HLS segments ignore `-hls_time` without forced keyframes. Both were found by review and reproduced before fixing.
- Without `-map`, FFmpeg encodes the largest video stream, not the first one the probe looked at. It only prefers the bigger one when it is much bigger (1280x720 next to 64x64 did not trigger it, 3840x2160 did), so a test with a mild difference passes without the fix. Run a new test once without the fix to see it fail.
- A capacity check before an upload streams in is not a limit: count in-flight uploads too.
- Retry policy needs error classes: 429/5xx/timeouts back off, other 4xx fail at once, raw provider text stays in the log.
- `fetch` normalises `..` in URLs, so path-traversal tests need a raw `http.request`.
- Local ffprobe 4.0.2 prints some `-show_entries` values twice; parse the first token.
- The first-commit history was assembled after the code was finished. Do not write README narratives that the history contradicts.

## Next
Try English and noisy audio, decide whether to build chunked analysis for long videos, bump the actions off the Node 20 runtime warning.
