import path from "node:path";
import { analyzeWithRetry } from "./analyze.js";
import { executeToolCalls } from "./clips.js";
import { cutClip, extractAudio, probe, transcodeToHls } from "./ffmpeg.js";
import type { JobStore } from "./jobs.js";
import type { LlmProvider } from "./llm/provider.js";

export interface PipelineDeps {
  store: JobStore;
  provider: LlmProvider;
  dataDir: string;
}

/** Runs in the background after the upload request has already returned 202. */
export async function runPipeline(id: string, inputFile: string, deps: PipelineDeps): Promise<void> {
  const { store, provider, dataDir } = deps;
  const dir = path.join(dataDir, id);
  try {
    store.update(id, "probing", "Reading video metadata");
    const info = await probe(inputFile);
    if (!info.hasVideo) throw new Error("The file has no video stream");
    if (!info.hasAudio) throw new Error("The video has no audio track, so there is nothing to analyse");

    store.update(id, "transcoding", "Transcoding to HLS (720p max)");
    await transcodeToHls(inputFile, path.join(dir, "hls"));

    store.update(id, "extracting_audio", "Extracting audio for the model");
    const audioFile = path.join(dir, "audio.mp3");
    await extractAudio(inputFile, audioFile);

    store.update(id, "analyzing", "Asking the model for chapters, quiz and highlights");
    const outcome = await analyzeWithRetry(provider, { path: audioFile, mimeType: "audio/mp3" }, info.durationSec);
    if (outcome.attempts > 1) {
      store.update(id, "analyzing", `Model answer rejected ${outcome.attempts - 1}x, accepted on attempt ${outcome.attempts}`);
    }

    let clips: Awaited<ReturnType<typeof executeToolCalls>>["clips"] = [];
    let rejected: Awaited<ReturnType<typeof executeToolCalls>>["rejected"] = [];
    if (outcome.analysis.hasSpeech) {
      store.update(id, "cutting_clips", "The model is choosing clips to cut (tool calls)");
      const calls = await provider.planClips(outcome.analysis, info.durationSec);
      ({ clips, rejected } = await executeToolCalls(calls, {
        durationSec: info.durationSec,
        clipsDir: path.join(dir, "clips"),
        cut: (out, start, end) => cutClip(inputFile, out, start, end),
      }));
    }

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
    store.fail(id, err instanceof Error ? err.message : String(err));
  }
}
