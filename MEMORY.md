# ClipPilot: decisions and lessons

## State (2026-11-01)
- Lint, typecheck, build and 14 tests pass. Real FFmpeg end-to-end test with a mock LLM.
- One real run with Gemini `gemini-3.5-flash-lite` on a 63 s English lesson worked (39 s). Not yet tested: Turkish audio, long videos, `docker build`.
- No git repo yet (git installed, identity set).

## Decisions
- LLM behind an interface; Gemini gets the extracted mono mp3 inline. Mock provider for tests.
- Never trust model output: zod schema + semantic checks (timestamps inside the video, ordered chapters, clip length), up to 3 attempts with the rejection reasons fed back. Tool-call args are re-validated before FFmpeg.
- Default model `gemini-3.5-flash-lite` (cheapest class). OpenAI credit is gone; DeepSeek cannot take audio.
- Kept tiny CI and the eval table because the job ad names CI/CD and verifying AI output.
- Out of scope: RTMP, RAG, auth, persistent queue, multi-rendition HLS.

## Lessons
- `ffmpeg-static` types are a namespace but the runtime value is a path string; cast explicitly.
- `.env` is not loaded by Node on its own: scripts use `--env-file-if-exists=.env` (Node >= 22.9).
- First real Gemini answer failed the schema (`highlights.0.reason` missing); the retry loop fixed it.

## Next
Real videos (Turkish too) -> fill README eval table -> `git init` and small commits -> push -> 90 s demo video -> cover letter.
