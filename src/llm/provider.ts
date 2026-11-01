import type { Analysis } from "../schema.js";

export interface AudioInput {
  path: string;
  mimeType: string;
}

export interface ToolCall {
  name: string;
  args: unknown;
}

/**
 * Everything the pipeline needs from an LLM. `analyze` returns unvalidated data on purpose:
 * the pipeline, not the provider, decides whether to trust it.
 */
export interface LlmProvider {
  analyze(audio: AudioInput, durationSec: number, feedback: string[], previous?: unknown): Promise<unknown>;
  /**
   * Second model call: given the highlight candidates, the model picks and trims clips by calling the
   * `cut_clip` tool. It sees the first call's output, not the audio.
   */
  planClips(analysis: Analysis, durationSec: number): Promise<ToolCall[]>;
}
