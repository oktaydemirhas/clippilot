import http from "node:http";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, FFPROBE, probe, run } from "../src/ffmpeg.js";
import { MockProvider } from "../src/llm/mock.js";
import type { LlmProvider } from "../src/llm/provider.js";
import { buildServer } from "../src/server.js";

/**
 * Real end-to-end runs: real FFmpeg, real HTTP upload, real SSE, real files on disk.
 * Only the LLM is replaced (by the deterministic mock or a small scripted provider).
 */

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

interface App {
  base: string;
  dataDir: string;
  close: () => Promise<void>;
}

async function startApp(tmp: string, name: string, over: Partial<Parameters<typeof buildServer>[0]> = {}): Promise<App> {
  const dataDir = path.join(tmp, name);
  const { app } = buildServer({
    provider: new MockProvider(),
    dataDir,
    maxUploadBytes: 50 * 1024 * 1024,
    publicDir,
    maxDurationSec: 600,
    maxConcurrentJobs: 2,
    maxQueuedJobs: 5,
    ...over,
  });
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  return { base, dataDir, close: () => app.close() };
}

async function upload(base: string, file: string, name: string, type: string): Promise<Response> {
  const form = new FormData();
  form.append("video", new Blob([await readFile(file)], { type }), name);
  return fetch(`${base}/api/videos`, { method: "POST", body: form });
}

/** The server closes the event stream at done/failed, so reading to the end waits for the job. */
async function waitForTerminal(base: string, id: string): Promise<string[]> {
  const text = await (await fetch(`${base}/api/videos/${id}/events`)).text();
  return [...text.matchAll(/data: (.*)\n\n/g)].map((m) => (JSON.parse(m[1]!) as { stage: string }).stage);
}

interface JobJson {
  stage: string;
  error?: string;
  result: { hlsUrl: string; clips: { url: string; start: number; end: number }[]; analysis: { chapters: unknown[]; hasSpeech: boolean } };
}

async function uploadAndWait(app: App, file: string, type = "video/mp4"): Promise<{ id: string; job: JobJson }> {
  const res = await upload(app.base, file, "x.mp4", type);
  expect(res.status).toBe(202);
  const { id } = (await res.json()) as { id: string };
  await waitForTerminal(app.base, id);
  return { id, job: (await (await fetch(`${app.base}/api/videos/${id}`)).json()) as JobJson };
}

/** fetch() normalises `..` away before sending, so traversal has to be tested with a raw request. */
function rawGet(base: string, rawPath: string): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath, method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("upload -> HLS + analysis + clips", () => {
  let tmp: string;
  let app: App;
  let sample: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "clippilot-"));
    sample = path.join(tmp, "sample.mp4");
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=12:size=640x360:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sample,
    ]);
    app = await startApp(tmp, "data");
  });

  afterAll(async () => {
    await app.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("streams progress, produces playable HLS with ~4 s segments, analysis and real clips", async () => {
    const res = await upload(app.base, sample, "lesson.mp4", "video/mp4");
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    const stages = await waitForTerminal(app.base, id);
    expect(stages).toEqual(
      expect.arrayContaining(["queued", "probing", "transcoding", "extracting_audio", "analyzing", "cutting_clips", "done"]),
    );

    const job = (await (await fetch(`${app.base}/api/videos/${id}`)).json()) as JobJson;
    expect(job.stage).toBe("done");
    expect(job.result.analysis.chapters.length).toBeGreaterThan(0);

    const playlist = await fetch(`${app.base}${job.result.hlsUrl}`);
    expect(playlist.status).toBe(200);
    const m3u8 = await playlist.text();
    expect(m3u8).toContain("#EXT-X-ENDLIST");
    const durations = [...m3u8.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    expect(durations.length).toBeGreaterThanOrEqual(3); // 12 s at 4 s per segment; ~10 s segments would give 2
    expect(Math.max(...durations)).toBeLessThan(4.6);

    const firstSegment = m3u8.split("\n").find((l) => l.endsWith(".ts"))!;
    const seg = await fetch(`${app.base}${job.result.hlsUrl.replace("index.m3u8", firstSegment)}`);
    expect(seg.status).toBe(200);
    expect((await seg.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    expect(job.result.clips).toHaveLength(2);
    for (const clip of job.result.clips) {
      const file = path.join(app.dataDir, id, "clips", path.basename(clip.url));
      expect((await stat(file)).size).toBeGreaterThan(1000);
      expect((await probe(file)).durationSec).toBeCloseTo(clip.end - clip.start, 0);
    }
  });

  it("reports a percentage that only goes up and ends at exactly 100 when the job is done", async () => {
    const res = await upload(app.base, sample, "p.mp4", "video/mp4");
    const { id } = (await res.json()) as { id: string };
    const text = await (await fetch(`${app.base}/api/videos/${id}/events`)).text();
    const events = [...text.matchAll(/data: (.*)\n\n/g)].map((m) => JSON.parse(m[1]!) as { stage: string; percent: number; message: string });
    const percents = events.map((e) => e.percent);
    expect(percents.every((p) => p >= 0 && p <= 100)).toBe(true);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    const last = events.at(-1)!;
    expect([last.stage, last.percent]).toEqual(["done", 100]);
    expect(percents.filter((p) => p === 100)).toHaveLength(1); // ticks never claim 100 early
    expect(((await (await fetch(`${app.base}/api/videos/${id}`)).json()) as { percent: number }).percent).toBe(100);
  });

  it("deletes the original upload and the extracted audio once the job has finished", async () => {
    const { id } = await uploadAndWait(app, sample);
    const files = await readdir(path.join(app.dataDir, id));
    expect(files.sort()).toEqual(["clips", "hls"]);
  });

  it("serves only HLS output and clips, and sends security headers", async () => {
    const { id } = await uploadAndWait(app, sample);
    expect((await fetch(`${app.base}/media/${id}/input.bin`)).status).toBe(404);
    expect((await fetch(`${app.base}/media/${id}/audio.mp3`)).status).toBe(404);
    // Literal `..` segments, as an attacker would send them (fetch() would normalise these away).
    expect(await rawGet(app.base, `/media/${id}/hls/../input.bin`)).toBe(404);
    expect(await rawGet(app.base, `/media/${id}/hls/%2e%2e/input.bin`)).toBe(404);
    expect(await rawGet(app.base, `/media/${id}/hls/..`)).toBe(404);
    expect(await rawGet(app.base, `/media/${id}/..%2f..%2fpackage.json`)).toBe(404);

    const page = await fetch(`${app.base}/`);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const hlsJs = await fetch(`${app.base}/vendor/hls.min.js`);
    expect(hlsJs.status).toBe(200);
    expect((await hlsJs.text()).length).toBeGreaterThan(100_000);
  });

  it("rejects declared non-video uploads and unknown ids", async () => {
    const txt = path.join(tmp, "a.txt");
    await writeFile(txt, "hello");
    expect((await upload(app.base, txt, "a.txt", "text/plain")).status).toBe(415);
    expect((await fetch(`${app.base}/api/videos/not-an-id`)).status).toBe(404);
  });

  it("fails cleanly, without leaking server paths, when a non-video claims to be video/mp4", async () => {
    const txt = path.join(tmp, "fake.mp4");
    await writeFile(txt, "this is not a video");
    const { job } = await uploadAndWait(app, txt);
    expect(job.stage).toBe("failed");
    expect(job.error).toBe("The file could not be read as a video");
    expect(job.error).not.toMatch(/[\\/]/);
  });

  it("refuses an HLS playlist disguised as a video: no request ever reaches the URL inside it", async () => {
    const hits: string[] = [];
    const target = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end();
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    try {
      const { port } = target.address() as { port: number };
      const playlist = path.join(tmp, "evil.mp4");
      await writeFile(playlist, `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttp://127.0.0.1:${port}/x.ts\n#EXT-X-ENDLIST\n`);
      // The format whitelist is what turns it away, not a lucky failure further down.
      await expect(probe(playlist)).rejects.toThrow(/whitelist/i);
      const { job } = await uploadAndWait(app, playlist);
      expect(job.stage).toBe("failed");
      expect(hits).toEqual([]);
    } finally {
      await new Promise((r) => target.close(r));
    }
  });

  it("works on the first video stream only: a huge second stream cannot slip past the resolution check", async () => {
    const twoVideos = path.join(tmp, "two-video.mkv");
    await run(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=8:size=64x64:rate=5",
      // FFmpeg only prefers the bigger stream when it is much bigger: 1280x720 next to 64x64 did not trigger it.
      "-f", "lavfi", "-i", "testsrc=duration=8:size=3840x2160:rate=5",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=8",
      "-map", "0:v", "-map", "1:v", "-map", "2:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", twoVideos,
    ]);
    const info = await probe(twoVideos);
    expect([info.width, info.height]).toEqual([64, 64]); // what the pixel cap looks at
    const { id, job } = await uploadAndWait(app, twoVideos, "application/octet-stream");
    expect(job.stage).toBe("done");
    // Without -map, FFmpeg encodes the 4K stream (capped to 720 high).
    const seg = path.join(app.dataDir, id, "hls", "seg_000.ts");
    const out = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", seg]);
    expect(Number(out.trim().split(/\s+/)[0])).toBe(64);
  });

  it("accepts other allowed containers (Matroska)", async () => {
    const mkv = path.join(tmp, "sample.mkv");
    await run(FFMPEG, ["-y", "-i", sample, "-c", "copy", mkv]);
    const { job } = await uploadAndWait(app, mkv, "application/octet-stream");
    expect(job.stage).toBe("done");
  });

  it("handles a video with an odd height (libx264 + yuv420p needs even dimensions)", async () => {
    const odd = path.join(tmp, "odd.mp4");
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=12:size=854x480:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=12",
      "-vf", "crop=854:479",
      "-c:v", "libx264", "-pix_fmt", "yuv444p", "-c:a", "aac", "-shortest", odd,
    ]);
    expect((await probe(odd)).height).toBe(479);
    const { id, job } = await uploadAndWait(app, odd);
    expect(job.stage).toBe("done");
    // Read our own output with plain ffprobe: probe() deliberately refuses MPEG-TS, it is not an upload format.
    const seg = path.join(app.dataDir, id, "hls", "seg_000.ts");
    const out = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", seg]);
    const height = Number(out.trim().split(/\s+/)[0]);
    expect(height).toBe(478);
  });

  it("reports a clear failure for a video without audio", async () => {
    const silent = path.join(tmp, "silent.mp4");
    await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x180:rate=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    const { job } = await uploadAndWait(app, silent);
    expect(job.stage).toBe("failed");
    expect(job.error).toContain("no audio track");
  });
});

describe("limits", () => {
  let tmp: string;
  let sample: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "clippilot-limits-"));
    sample = path.join(tmp, "sample.mp4");
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=12:size=320x180:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sample,
    ]);
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it("rejects a video longer than the duration limit", async () => {
    const app = await startApp(tmp, "d1", { maxDurationSec: 5 });
    try {
      const { job } = await uploadAndWait(app, sample);
      expect(job.stage).toBe("failed");
      expect(job.error).toContain("The limit is");
    } finally {
      await app.close();
    }
  });

  it("answers 413 for an oversized upload and leaves no partial file behind", async () => {
    const app = await startApp(tmp, "d2", { maxUploadBytes: 1024 * 1024 });
    try {
      const big = path.join(tmp, "big.mp4");
      await writeFile(big, Buffer.alloc(3 * 1024 * 1024, 1));
      const res = await upload(app.base, big, "big.mp4", "video/mp4");
      expect(res.status).toBe(413);
      expect(await readdir(app.dataDir)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("answers 503 when the worker and the queue are full", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: LlmProvider = {
      analyze: async (audio, durationSec) => {
        await gate;
        return new MockProvider().analyze(audio, durationSec);
      },
      planClips: (a) => new MockProvider().planClips(a),
    };
    const app = await startApp(tmp, "d3", { provider: slow, maxConcurrentJobs: 1, maxQueuedJobs: 0 });
    try {
      const first = await upload(app.base, sample, "a.mp4", "video/mp4");
      expect(first.status).toBe(202);
      const second = await upload(app.base, sample, "b.mp4", "video/mp4");
      expect(second.status).toBe(503);
      release();
      const { id } = (await first.json()) as { id: string };
      await waitForTerminal(app.base, id);
    } finally {
      release();
      await app.close();
    }
  });

  it("parallel uploads cannot all pass the capacity check before any of them is queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: LlmProvider = {
      analyze: async (audio, durationSec) => {
        await gate;
        return new MockProvider().analyze(audio, durationSec);
      },
      planClips: (a) => new MockProvider().planClips(a),
    };
    // Room for exactly two jobs: one running, one queued.
    const app = await startApp(tmp, "d5", { provider: slow, maxConcurrentJobs: 1, maxQueuedJobs: 1 });
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => upload(app.base, sample, "p.mp4", "video/mp4")));
      const accepted = results.filter((r) => r.status === 202);
      expect(accepted).toHaveLength(2);
      expect(results.filter((r) => r.status === 503)).toHaveLength(4);
      expect(await readdir(app.dataDir)).toHaveLength(2); // the refused ones never wrote anything
      release();
      for (const r of accepted) await waitForTerminal(app.base, ((await r.json()) as { id: string }).id);
    } finally {
      release();
      await app.close();
    }
  });

  it("a failing second model call (planClips) keeps the finished job instead of failing it", async () => {
    const flaky: LlmProvider = {
      analyze: (audio, durationSec) => new MockProvider().analyze(audio, durationSec),
      planClips: () => Promise.reject(Object.assign(new Error("rate limited at /secret/path"), { status: 429 })),
    };
    const app = await startApp(tmp, "d6", { provider: flaky });
    try {
      const { job } = await uploadAndWait(app, sample);
      expect(job.stage).toBe("done");
      expect(job.result.analysis.chapters.length).toBeGreaterThan(0);
      expect(job.result.clips).toEqual([]);
      expect(JSON.stringify(job)).not.toContain("/secret/path");
    } finally {
      await app.close();
    }
  });

  it("a rejected API key fails the job with a generic message and no raw provider text", async () => {
    let calls = 0;
    const badKey: LlmProvider = {
      analyze: () => {
        calls++;
        return Promise.reject(Object.assign(new Error("API key not valid: AIzaSECRET"), { status: 401 }));
      },
      planClips: () => Promise.resolve([]),
    };
    const app = await startApp(tmp, "d7", { provider: badKey });
    try {
      const { job } = await uploadAndWait(app, sample);
      expect(job.stage).toBe("failed");
      expect(job.error).toBe("The AI analysis failed after several attempts. Try again later");
      expect(calls).toBe(1); // no retries for a 401
    } finally {
      await app.close();
    }
  });

  it("refuses unknown Host headers (DNS rebinding) and cross-site POSTs", async () => {
    const app = await startApp(tmp, "d8");
    try {
      const { hostname, port } = new URL(app.base);
      const send = (method: string, headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const req = http.request({ hostname, port, path: "/api/videos/not-an-id", method, headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        });
      expect(await send("GET", {})).toBe(404); // normal request: reaches the route
      expect(await send("GET", { Host: "evil.example.com" })).toBe(403);
      expect(await send("GET", { Host: `localhost:${port}` })).toBe(404);
      expect(await send("POST", { Origin: "https://evil.example.com" })).toBe(403);
      expect(await send("POST", { Origin: "null" })).toBe(403);
      expect(await send("POST", { Origin: `http://127.0.0.1:${port}` })).not.toBe(403);
    } finally {
      await app.close();
    }
  });

  it("runs the whole pipeline for a recording without speech: no quiz, no clips, no forced tool call", async () => {
    let planned = false;
    const music: LlmProvider = {
      analyze: () =>
        Promise.resolve({ hasSpeech: false, summary: "Instrumental music, no talking.", chapters: [], quiz: [], highlights: [] }),
      planClips: () => {
        planned = true;
        return Promise.resolve([]);
      },
    };
    const app = await startApp(tmp, "d4", { provider: music });
    try {
      const { job } = await uploadAndWait(app, sample);
      expect(job.stage).toBe("done");
      expect(job.result.analysis.hasSpeech).toBe(false);
      expect(job.result.clips).toEqual([]);
      expect(planned).toBe(false);
    } finally {
      await app.close();
    }
  });
});
