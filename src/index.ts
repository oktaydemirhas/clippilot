import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { startJanitor } from "./janitor.js";
import { GeminiProvider } from "./llm/gemini.js";
import { MockProvider } from "./llm/mock.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const provider =
  config.llm === "mock" ? new MockProvider() : new GeminiProvider(config.geminiApiKey ?? "", config.geminiModel);

const here = path.dirname(fileURLToPath(import.meta.url));
const { app, store } = buildServer({
  provider,
  dataDir: config.dataDir,
  maxUploadBytes: config.maxUploadBytes,
  publicDir: path.resolve(here, "..", "public"),
  maxDurationSec: config.maxDurationSec,
  maxConcurrentJobs: config.maxConcurrentJobs,
  maxQueuedJobs: config.maxQueuedJobs,
  allowedHosts: config.allowedHosts,
});

const stopJanitor = startJanitor(store, config.dataDir, config.jobTtlMs);
// `docker stop` sends SIGTERM; without a handler node would be SIGKILLed after 10 s.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopJanitor();
    void app.close().finally(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
console.log(`ClipPilot on http://${config.host}:${config.port} (LLM provider: ${config.llm})`);
