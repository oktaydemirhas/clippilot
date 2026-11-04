import type { AudioInput, LlmProvider } from "./llm/provider.js";
import { type Analysis, AnalysisSchema, semanticIssues } from "./schema.js";

export interface AnalysisOutcome {
  analysis: Analysis;
  attempts: number;
  /** Problems found on each rejected attempt, in order. Empty when the first answer was accepted. */
  rejected: string[][];
}

const MAX_ATTEMPTS = 3;

export interface RetryOptions {
  /** First wait after a failed request; doubles each time, plus jitter. Tests pass 0. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The HTTP status of a failed provider call, if it carries one (the Gemini SDK's ApiError has `status`). */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** A 4xx other than 429 (bad key, bad request) will fail the same way every time, so retrying only burns quota. */
function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  return status === undefined || status === 429 || status === 408 || status >= 500;
}

/**
 * Never trust model output. Each answer must pass the zod schema AND the semantic checks
 * (timestamps inside the video, ordered chapters, sane clip lengths). A rejected answer is
 * sent back to the model together with the exact reasons, immediately.
 * A provider that throws is handled separately: network errors, timeouts, 429 and 5xx are retried
 * with exponential backoff and jitter; other 4xx errors fail at once. The raw error text is only logged,
 * because it can contain server paths or API response bodies and ends up in the job record.
 */
export async function analyzeWithRetry(
  provider: LlmProvider,
  audio: AudioInput,
  durationSec: number,
  { baseDelayMs = 1000, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) }: RetryOptions = {},
): Promise<AnalysisOutcome> {
  const rejected: string[][] = [];
  let feedback: string[] = [];
  let previous: unknown;
  let failedRequests = 0;
  let waitMs = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let issues: string[];
    try {
      if (waitMs > 0) await sleep(waitMs);
      waitMs = 0;
      const raw = await provider.analyze(audio, durationSec, feedback, previous);
      const parsed = AnalysisSchema.safeParse(raw);
      issues = parsed.success
        ? semanticIssues(parsed.data, durationSec)
        : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      if (parsed.success && issues.length === 0) return { analysis: parsed.data, attempts: attempt, rejected };
      previous = raw;
    } catch (err) {
      console.error(`model request failed (attempt ${attempt}):`, err);
      if (!isRetryable(err)) throw err;
      const status = statusOf(err);
      issues = [`the request to the model failed${status ? ` (HTTP ${status})` : ""}`];
      previous = undefined;
      failedRequests++;
      waitMs = baseDelayMs * 2 ** (failedRequests - 1) * (1 + Math.random() * 0.5);
    }
    rejected.push(issues);
    feedback = issues;
  }
  throw new Error(`The model did not produce a valid analysis after ${MAX_ATTEMPTS} attempts: ${feedback.join("; ")}`);
}
