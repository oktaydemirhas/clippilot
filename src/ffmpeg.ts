import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

// ffmpeg-static's type declaration is a namespace, but at runtime it is the binary path (or null).
export const FFMPEG: string = process.env.FFMPEG_PATH ?? (ffmpegStatic as unknown as string | null) ?? "ffmpeg";
export const FFPROBE: string = process.env.FFPROBE_PATH ?? ffprobeStatic.path;

/**
 * Runs a binary without a shell and without blocking the event loop.
 * Keeps only the tail of stderr so a long encode cannot exhaust memory.
 */
export function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(out);
      const tail = err.trim().split("\n").slice(-5).join("\n");
      reject(new Error(`${path.basename(bin)} exited with code ${code}: ${tail}`));
    });
  });
}

export interface MediaInfo {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export async function probe(file: string): Promise<MediaInfo> {
  const out = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "json",
    file,
  ]);
  const json = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string }[] };
  const durationSec = Number(json.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("Could not determine video duration; the file may be corrupt");
  }
  const types = (json.streams ?? []).map((s) => s.codec_type);
  return { durationSec, hasVideo: types.includes("video"), hasAudio: types.includes("audio") };
}

/** Single-rendition VOD HLS capped at 720p. Returns the playlist path. */
export async function transcodeToHls(input: string, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const playlist = path.join(outDir, "index.m3u8");
  await run(FFMPEG, [
    "-y", "-i", input,
    "-vf", "scale=-2:min(720\\,ih)",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
    "-hls_segment_filename", path.join(outDir, "seg_%03d.ts"),
    playlist,
  ]);
  return playlist;
}

/** Mono 16 kHz MP3: small enough to send inline to an LLM (~14 MB per hour at 32 kbps). */
export async function extractAudio(input: string, output: string): Promise<void> {
  await run(FFMPEG, ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", output]);
}

/** Frame-accurate cut (re-encoded) so clips start exactly where the model said. */
export async function cutClip(input: string, output: string, start: number, end: number): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await run(FFMPEG, [
    "-y", "-ss", start.toFixed(3), "-i", input, "-t", (end - start).toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    output,
  ]);
}
