import path from "node:path";
import type { ToolCall } from "./llm/provider.js";
import { CutClipArgs, MAX_CLIP_SEC, MAX_CLIPS, MIN_CLIP_SEC } from "./schema.js";

export interface ClipInfo {
  title: string;
  start: number;
  end: number;
  file: string;
}

export interface RejectedCall {
  call: ToolCall;
  reason: string;
}

export interface ToolContext {
  durationSec: number;
  clipsDir: string;
  cut: (output: string, start: number, end: number) => Promise<void>;
}

/**
 * The model proposes, this code disposes. Tool-call arguments come from an LLM, so they are
 * validated (schema, bounds, length, count) before anything reaches FFmpeg.
 */
export async function executeToolCalls(
  calls: ToolCall[],
  ctx: ToolContext,
): Promise<{ clips: ClipInfo[]; rejected: RejectedCall[] }> {
  const clips: ClipInfo[] = [];
  const rejected: RejectedCall[] = [];

  for (const call of calls) {
    if (call.name !== "cut_clip") {
      rejected.push({ call, reason: `unknown tool "${call.name}"` });
      continue;
    }
    if (clips.length >= MAX_CLIPS) {
      rejected.push({ call, reason: `at most ${MAX_CLIPS} clips are allowed` });
      continue;
    }
    const parsed = CutClipArgs.safeParse(call.args);
    if (!parsed.success) {
      rejected.push({ call, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      continue;
    }
    const { start, title } = parsed.data;
    const end = Math.min(parsed.data.end, ctx.durationSec);
    if (start >= ctx.durationSec) {
      rejected.push({ call, reason: `start ${start}s is beyond the video duration ${ctx.durationSec.toFixed(1)}s` });
      continue;
    }
    const len = end - start;
    if (len < MIN_CLIP_SEC || len > MAX_CLIP_SEC) {
      rejected.push({ call, reason: `clip length ${len.toFixed(1)}s must be between ${MIN_CLIP_SEC} and ${MAX_CLIP_SEC}s` });
      continue;
    }
    const file = `clip-${clips.length + 1}.mp4`;
    await ctx.cut(path.join(ctx.clipsDir, file), start, end);
    clips.push({ title, start, end, file });
  }
  return { clips, rejected };
}
