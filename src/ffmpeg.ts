import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

// ffmpeg-static's type declaration is a namespace, but at runtime it is the binary path (or null).
export const FFMPEG: string = process.env.FFMPEG_PATH ?? (ffmpegStatic as unknown as string | null) ?? "ffmpeg";
export const FFPROBE: string = process.env.FFPROBE_PATH ?? ffprobeStatic.path;

/** Container formats we accept. FFmpeg detects the format from the content, never from the file name. */
const ALLOWED_DEMUXERS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi";

/**
 * Input options for every file that came from an upload. Without them FFmpeg would happily open an HLS
 * playlist disguised as a video and follow whatever it references.
 */
const UNTRUSTED_INPUT = ["-protocol_whitelist", "file", "-format_whitelist", ALLOWED_DEMUXERS];

/**
 * Runs a binary without a shell and without blocking the event loop.
 * Keeps only the tail of stderr so a long encode cannot exhaust memory, and kills the process on timeout.
 */
export function run(bin: string, args: string[], timeoutMs = 30 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s`));
      if (code === 0) return resolve(out);
      const tail = err.trim().split("\n").slice(-5).join("\n");
      reject(new Error(`${path.basename(bin)} exited with code ${code}: ${tail}`));
    });
  });
}

export interface MediaInfo {
  durationSec: number;
  /** ffprobe's demuxer name, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  formatName: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
}

interface ProbeJson {
  format?: { duration?: string; format_name?: string };
  streams?: { codec_type?: string; width?: number; height?: number; disposition?: { attached_pic?: number } }[];
}

export async function probe(file: string): Promise<MediaInfo> {
  const out = await run(
    FFPROBE,
    [
      "-v", "error",
      ...UNTRUSTED_INPUT,
      "-show_entries", "format=duration,format_name:stream=codec_type,width,height:stream_disposition=attached_pic",
      "-of", "json",
      file,
    ],
    30_000,
  );
  const json = JSON.parse(out) as ProbeJson;
  const durationSec = Number(json.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("Could not determine video duration; the file may be corrupt");
  }
  const streams = json.streams ?? [];
  // An MP3 with cover art contains a "video" stream that is just a picture.
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  return {
    durationSec,
    formatName: json.format?.format_name ?? "",
    hasVideo: video !== undefined,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
  };
}

/**
 * Which streams FFmpeg works on. Without -map it would pick the highest-resolution video stream, while
 * probe() checked the first one: a file could hide a huge second stream behind a tiny first one.
 * `V` (capital) skips cover-art pictures, matching what probe() counts as video.
 */
const MAP_FIRST_STREAMS = ["-map", "0:V:0", "-map", "0:a:0"];

/** Output cap: the container header's duration is a claim, not a guarantee. */
const capSeconds = (durationSec: number): string[] => ["-t", String(Math.ceil(durationSec) + 1)];

/** Single-rendition VOD HLS capped at 720p. Returns the playlist path. */
export async function transcodeToHls(input: string, outDir: string, timeoutMs?: number, durationSec?: number): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const playlist = path.join(outDir, "index.m3u8");
  await run(
    FFMPEG,
    [
      "-y", ...UNTRUSTED_INPUT, "-i", input, ...MAP_FIRST_STREAMS,
      ...(durationSec ? capSeconds(durationSec) : []),
      // yuv420p needs even dimensions, so round the height down to an even number.
      "-vf", "scale=-2:min(720\\,trunc(ih/2)*2)",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      // Without forced keyframes libx264 only starts a segment every ~250 frames, ignoring hls_time.
      "-force_key_frames", "expr:gte(t,n_forced*4)",
      "-c:a", "aac", "-b:a", "128k",
      "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
      "-hls_segment_filename", path.join(outDir, "seg_%03d.ts"),
      playlist,
    ],
    timeoutMs,
  );
  return playlist;
}

/** Mono 16 kHz MP3: small enough to send inline to an LLM (~14 MB per hour at 32 kbps). */
export async function extractAudio(input: string, output: string, timeoutMs?: number, durationSec?: number): Promise<void> {
  await run(
    FFMPEG,
    [
      "-y", ...UNTRUSTED_INPUT, "-i", input, "-map", "0:a:0", ...(durationSec ? capSeconds(durationSec) : []),
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", output,
    ],
    timeoutMs,
  );
}

/** Frame-accurate cut (re-encoded) so clips start exactly where the model said. */
export async function cutClip(input: string, output: string, start: number, end: number): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await run(
    FFMPEG,
    [
      "-y", ...UNTRUSTED_INPUT, "-ss", start.toFixed(3), "-i", input, ...MAP_FIRST_STREAMS, "-t", (end - start).toFixed(3),
      "-vf", "scale=-2:min(720\\,trunc(ih/2)*2)",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
      output,
    ],
    10 * 60_000,
  );
}
