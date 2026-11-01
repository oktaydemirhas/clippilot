import type { AudioInput, LlmProvider } from "./llm/provider.js";
import { type Analysis, AnalysisSchema, semanticIssues } from "./schema.js";

export interface AnalysisOutcome {
  analysis: Analysis;
  attempts: number;
  /** Problems found on each rejected attempt, in order. Empty when the first answer was accepted. */
  rejected: string[][];
}

const MAX_ATTEMPTS = 3;

/**
 * Never trust model output. Each answer must pass the zod schema AND the semantic checks
 * (timestamps inside the video, ordered chapters, sane clip lengths). A rejected answer is
 * sent back to the model together with the exact reasons.
 */
export async function analyzeWithRetry(
  provider: LlmProvider,
  audio: AudioInput,
  durationSec: number,
): Promise<AnalysisOutcome> {
  const rejected: string[][] = [];
  let feedback: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await provider.analyze(audio, durationSec, feedback);
    const parsed = AnalysisSchema.safeParse(raw);
    const issues = parsed.success
      ? semanticIssues(parsed.data, durationSec)
      : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

    if (parsed.success && issues.length === 0) return { analysis: parsed.data, attempts: attempt, rejected };
    rejected.push(issues);
    feedback = issues;
  }
  throw new Error(`The model did not produce a valid analysis after ${MAX_ATTEMPTS} attempts: ${feedback.join("; ")}`);
}
