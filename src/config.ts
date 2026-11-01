import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  llm: "gemini" | "mock";
  geminiApiKey?: string;
  geminiModel: string;
  maxUploadBytes: number;
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
    port: Number(env.PORT ?? 3000),
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    llm,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL ?? "gemini-3.5-flash-lite",
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 500) * 1024 * 1024,
  };
}
