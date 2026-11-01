import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FFMPEG, probe, run } from "../src/ffmpeg.js";
import { MockProvider } from "../src/llm/mock.js";
import { buildServer } from "../src/server.js";

/**
 * Real end-to-end run: real FFmpeg, real HTTP upload, real SSE, real files on disk.
 * Only the LLM is replaced by the deterministic mock.
 */
describe("upload -> HLS + analysis + clips", () => {
  let tmp: string;
  let base: string;
  let close: () => Promise<void>;
  let sample: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "clippilot-"));
    sample = path.join(tmp, "sample.mp4");
    await run(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=12:size=640x360:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", sample,
    ]);
    const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
    const { app } = buildServer({
      provider: new MockProvider(),
      dataDir: path.join(tmp, "data"),
      maxUploadBytes: 50 * 1024 * 1024,
      publicDir,
    });
    base = await app.listen({ port: 0, host: "127.0.0.1" });
    close = () => app.close();
  });

  afterAll(async () => {
    await close();
    await rm(tmp, { recursive: true, force: true });
  });

  async function upload(file: string, name: string, type: string): Promise<Response> {
    const form = new FormData();
    form.append("video", new Blob([await readFile(file)], { type }), name);
    return fetch(`${base}/api/videos`, { method: "POST", body: form });
  }

  async function waitForTerminal(id: string): Promise<string[]> {
    const res = await fetch(`${base}/api/videos/${id}/events`);
    const text = await res.text(); // the server closes the stream at done/failed
    return [...text.matchAll(/data: (.*)\n\n/g)].map((m) => (JSON.parse(m[1]!) as { stage: string }).stage);
  }

  it("streams progress, produces playable HLS, analysis and real clips", async () => {
    const res = await upload(sample, "lesson.mp4", "video/mp4");
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    const stages = await waitForTerminal(id);
    expect(stages).toEqual(
      expect.arrayContaining(["queued", "probing", "transcoding", "extracting_audio", "analyzing", "cutting_clips", "done"]),
    );

    const job = (await (await fetch(`${base}/api/videos/${id}`)).json()) as {
      stage: string;
      result: { hlsUrl: string; clips: { url: string; start: number; end: number }[]; analysis: { chapters: unknown[] } };
    };
    expect(job.stage).toBe("done");
    expect(job.result.analysis.chapters.length).toBeGreaterThan(0);

    const playlist = await fetch(`${base}${job.result.hlsUrl}`);
    expect(playlist.status).toBe(200);
    const m3u8 = await playlist.text();
    expect(m3u8).toContain("#EXTM3U");
    expect(m3u8).toContain("#EXT-X-ENDLIST");
    const firstSegment = m3u8.split("\n").find((l) => l.endsWith(".ts"))!;
    const seg = await fetch(`${base}${job.result.hlsUrl.replace("index.m3u8", firstSegment)}`);
    expect(seg.status).toBe(200);
    expect((await seg.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    expect(job.result.clips).toHaveLength(2);
    for (const clip of job.result.clips) {
      const file = path.join(tmp, "data", id, "clips", path.basename(clip.url));
      expect((await stat(file)).size).toBeGreaterThan(1000);
      const info = await probe(file);
      expect(info.durationSec).toBeCloseTo(clip.end - clip.start, 0);
    }
  });

  it("does not expose the original upload or the extracted audio", async () => {
    const { id } = (await (await upload(sample, "x.mp4", "video/mp4")).json()) as { id: string };
    await waitForTerminal(id);
    expect((await fetch(`${base}/media/${id}/input.mp4`)).status).toBe(404);
    expect((await fetch(`${base}/media/${id}/audio.mp3`)).status).toBe(404);
    expect((await fetch(`${base}/media/${id}/hls/../input.mp4`)).status).toBe(404);
  });

  it("rejects non-video uploads and unknown ids", async () => {
    const txt = path.join(tmp, "a.txt");
    await run(FFMPEG, ["-version"]); // sanity: binary runs
    const { writeFile } = await import("node:fs/promises");
    await writeFile(txt, "hello");
    expect((await upload(txt, "a.txt", "text/plain")).status).toBe(415);
    expect((await fetch(`${base}/api/videos/not-an-id`)).status).toBe(404);
  });

  it("reports a clear failure for a video without audio", async () => {
    const silent = path.join(tmp, "silent.mp4");
    await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x180:rate=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    const { id } = (await (await upload(silent, "silent.mp4", "video/mp4")).json()) as { id: string };
    const stages = await waitForTerminal(id);
    expect(stages.at(-1)).toBe("failed");
    const job = (await (await fetch(`${base}/api/videos/${id}`)).json()) as { error: string };
    expect(job.error).toContain("no audio track");
  });
});
