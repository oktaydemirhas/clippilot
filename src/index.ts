import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { GeminiProvider } from "./llm/gemini.js";
import { MockProvider } from "./llm/mock.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const provider =
  config.llm === "mock" ? new MockProvider() : new GeminiProvider(config.geminiApiKey ?? "", config.geminiModel);

const here = path.dirname(fileURLToPath(import.meta.url));
const { app } = buildServer({
  provider,
  dataDir: config.dataDir,
  maxUploadBytes: config.maxUploadBytes,
  publicDir: path.resolve(here, "..", "public"),
});

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`ClipPilot on http://localhost:${config.port} (LLM provider: ${config.llm})`);
