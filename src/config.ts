import path from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  llm: "gemini" | "mock";
  geminiApiKey?: string;
  geminiModel: string;
  maxUploadBytes: number;
  maxDurationSec: number;
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  jobTtlMs: number;
}

/** Reads an integer env var and fails loudly on junk: `Number("abc")` is NaN and would silently disable limits. */
function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const llm = (env.LLM_PROVIDER ?? "gemini") as Config["llm"];
  if (llm !== "gemini" && llm !== "mock") {
    throw new Error(`LLM_PROVIDER must be "gemini" or "mock", got "${llm}"`);
  }
  if (llm === "gemini" && !env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER=gemini (use LLM_PROVIDER=mock for offline runs)');
  }
  return {
    // Loopback by default: the API has no auth and every upload costs CPU and model calls.
    host: env.HOST || "127.0.0.1",
    port: intEnv(env, "PORT", 3000, 0, 65535),
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    llm,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL ?? "gemini-3.5-flash-lite",
    maxUploadBytes: intEnv(env, "MAX_UPLOAD_MB", 500, 1, 5000) * 1024 * 1024,
    // 45 min of 32 kbps mono audio is about 11 MB, which still fits an inline Gemini request.
    maxDurationSec: intEnv(env, "MAX_DURATION_MIN", 45, 1, 600) * 60,
    maxConcurrentJobs: intEnv(env, "MAX_CONCURRENT_JOBS", 1, 1, 16),
    maxQueuedJobs: intEnv(env, "MAX_QUEUED_JOBS", 5, 0, 1000),
    jobTtlMs: intEnv(env, "JOB_TTL_HOURS", 24, 1, 24 * 30) * 3_600_000,
  };
}
