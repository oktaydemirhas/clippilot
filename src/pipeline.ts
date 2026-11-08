import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { analyzeWithRetry } from "./analyze.js";
import { executeToolCalls } from "./clips.js";
import { UserError } from "./errors.js";
import { cutClip, extractAudio, probe, transcodeToHls } from "./ffmpeg.js";
import type { JobStore, Stage } from "./jobs.js";
import type { LlmProvider } from "./llm/provider.js";

export interface PipelineDeps {
  store: JobStore;
  provider: LlmProvider;
  dataDir: string;
  maxDurationSec: number;
}

const MAX_PIXELS = 3840 * 2160;
const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;
const CONTAINERS = ["mov", "mp4", "matroska", "webm", "avi"];

/** What the uploader sees when something unexpected breaks. The real error goes to the server log. */
const FRIENDLY: Partial<Record<Stage, string>> = {
  probing: "The file could not be read as a video",
  transcoding: "The video could not be converted for streaming",
  extracting_audio: "The audio track could not be extracted",
  analyzing: "The AI analysis failed after several attempts. Try again later",
  cutting_clips: "The highlight clips could not be created",
};

/** Runs in the background after the upload request has already returned 202. */
export async function runPipeline(id: string, inputFile: string, deps: PipelineDeps): Promise<void> {
  const { store, provider, dataDir, maxDurationSec } = deps;
  const dir = path.join(dataDir, id);
  const audioFile = path.join(dir, "audio.mp3");
  // The original (up to the upload limit) and the audio are not needed once the outputs exist. This runs before
  // the job is marked done or failed, so a client that sees the final event also sees the files gone.
  const cleanup = () => Promise.all([rm(inputFile, { force: true }), rm(audioFile, { force: true })]);
  try {
    store.update(id, "probing", "Reading video metadata", 2);
    const info = await probe(inputFile);
    if (!CONTAINERS.some((c) => info.formatName.split(",").includes(c))) {
      throw new UserError("Unsupported file type. Upload an MP4, MOV, MKV, WebM or AVI video");
    }
    if (!info.hasVideo) throw new UserError("The file has no video stream");
    if (!info.hasAudio) throw new UserError("The video has no audio track, so there is nothing to analyse");
    if (info.durationSec > maxDurationSec) {
      throw new UserError(`The video is ${Math.ceil(info.durationSec / 60)} min long. The limit is ${Math.floor(maxDurationSec / 60)} min`);
    }
    if (info.width * info.height > MAX_PIXELS) throw new UserError("The video resolution is above 4K");

    // Generous but finite: a stuck encoder is killed instead of holding a worker forever.
    const encodeTimeoutMs = Math.max(120_000, info.durationSec * 2000);

    store.update(id, "transcoding", "Transcoding to HLS (720p max)", 5);
    await transcodeToHls(inputFile, path.join(dir, "hls"), encodeTimeoutMs, info.durationSec, (f) =>
      store.progress(id, 5 + f * 55),
    );

    store.update(id, "extracting_audio", "Extracting audio for the model", 62);
    await extractAudio(inputFile, audioFile, encodeTimeoutMs, info.durationSec);
    if ((await stat(audioFile)).size > MAX_INLINE_AUDIO_BYTES) {
      throw new UserError("The audio is too large to analyse in one request");
    }

    // No honest percentage exists while the model thinks, so the bar waits here until the answer is in.
    store.update(id, "analyzing", "Waiting for the model: chapters, quiz and highlights", 70);
    const outcome = await analyzeWithRetry(provider, { path: audioFile, mimeType: "audio/mp3" }, info.durationSec);
    if (outcome.attempts > 1) {
      store.update(id, "analyzing", `Model answer rejected ${outcome.attempts - 1}x, accepted on attempt ${outcome.attempts}`);
    }

    let clips: Awaited<ReturnType<typeof executeToolCalls>>["clips"] = [];
    let rejected: Awaited<ReturnType<typeof executeToolCalls>>["rejected"] = [];
    // With no speech or no candidates there is nothing to choose from; a forced tool call would invent a clip.
    if (outcome.analysis.hasSpeech && outcome.analysis.highlights.length > 0) {
      store.update(id, "cutting_clips", "The model is choosing clips to cut (tool calls)", 90);
      let cut = 0;
      try {
        const calls = await provider.planClips(outcome.analysis, info.durationSec);
        ({ clips, rejected } = await executeToolCalls(calls, {
          durationSec: info.durationSec,
          clipsDir: path.join(dir, "clips"),
          cut: async (out, start, end) => {
            await cutClip(inputFile, out, start, end);
            store.progress(id, 90 + (9 * ++cut) / Math.max(1, calls.length));
          },
        }));
      } catch (err) {
        // The clips are a bonus. A rate limit or timeout on this second model call must not throw away
        // the HLS output and the analysis that already succeeded.
        console.error(`job ${id}: planning clips failed:`, err);
        clips = [];
        rejected = [{ call: { name: "plan_clips", args: {} }, reason: "the model could not plan clips" }];
      }
    }

    await cleanup();
    store.complete(id, {
      durationSec: info.durationSec,
      hlsUrl: `/media/${id}/hls/index.m3u8`,
      analysis: outcome.analysis,
      analysisAttempts: outcome.attempts,
      rejectedAnalyses: outcome.rejected,
      clips: clips.map((c) => ({ ...c, url: `/media/${id}/clips/${c.file}` })),
      rejectedToolCalls: rejected,
    });
  } catch (err) {
    await cleanup();
    if (err instanceof UserError) {
      store.fail(id, err.message);
    } else {
      console.error(`job ${id} failed:`, err);
      store.fail(id, FRIENDLY[store.get(id)?.stage ?? "probing"] ?? "Processing failed");
    }
  }
}
