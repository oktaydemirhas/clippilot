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
  analyze(audio: AudioInput, durationSec: number, feedback: string[]): Promise<unknown>;
  /** Agentic step: the model decides which clips to cut by calling the `cut_clip` tool. */
  planClips(analysis: Analysis, durationSec: number): Promise<ToolCall[]>;
}
