// Sends video files to a running ClipPilot server and prints one JSON summary per file.
//
//   LLM_PROVIDER=gemini GEMINI_API_KEY=... npm run dev     (in another terminal)
//   node scripts/eval.mjs path/to/a.mp4 path/to/b.mp4
//
// Set BASE_URL if the server is not on http://localhost:3000. Nothing is stored: pipe the output to a file to keep it.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/eval.mjs <video> [<video> ...]");
  process.exit(1);
}

for (const file of files) {
  const started = Date.now();
  const form = new FormData();
  form.append("video", new Blob([await readFile(file)], { type: "video/mp4" }), basename(file));
  const up = await fetch(`${base}/api/videos`, { method: "POST", body: form });
  if (!up.ok) {
    console.log(JSON.stringify({ file: basename(file), uploadStatus: up.status, error: (await up.json().catch(() => ({}))).error }));
    continue;
  }
  const { id } = await up.json();
  let job;
  for (;;) {
    job = await (await fetch(`${base}/api/videos/${id}`)).json();
    if (job.stage === "done" || job.stage === "failed") break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const r = job.result;
  console.log(
    JSON.stringify(
      {
        file: basename(file),
        stage: job.stage,
        seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        error: job.error,
        durationSec: r?.durationSec,
        attempts: r?.analysisAttempts,
        rejected: r?.rejectedAnalyses,
        rejectedToolCalls: r?.rejectedToolCalls,
        hasSpeech: r?.analysis?.hasSpeech,
        chapters: r?.analysis?.chapters?.map((c) => `${c.start}: ${c.title}`),
        quiz: r?.analysis?.quiz?.map((q) => `${q.at}: ${q.question}`),
        clips: r?.clips?.map((c) => `${c.start}-${c.end}: ${c.title}`),
        summary: r?.analysis?.summary,
      },
      null,
      1,
    ),
  );
}
