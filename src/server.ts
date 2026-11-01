import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { isTerminal, type JobEvent, JobStore } from "./jobs.js";
import type { LlmProvider } from "./llm/provider.js";
import { runPipeline } from "./pipeline.js";

export interface ServerOptions {
  provider: LlmProvider;
  dataDir: string;
  maxUploadBytes: number;
  publicDir: string;
}

const ID_RE = /^[0-9a-f-]{36}$/;
const MEDIA_RE = /^(hls|clips)\/[\w.-]+$/;

export function buildServer(opts: ServerOptions): { app: FastifyInstance; store: JobStore } {
  const app = Fastify({ logger: false });
  const store = new JobStore();

  void app.register(multipart, { limits: { fileSize: opts.maxUploadBytes, files: 1 } });
  void app.register(fastifyStatic, { root: opts.publicDir });

  app.post("/api/videos", async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "Send the video as multipart/form-data" });
    if (!file.mimetype.startsWith("video/")) {
      file.file.resume();
      return reply.code(415).send({ error: `Expected a video file, got ${file.mimetype}` });
    }

    const id = randomUUID();
    const dir = path.join(opts.dataDir, id);
    await mkdir(dir, { recursive: true });
    const ext = path.extname(file.filename).toLowerCase().replace(/[^.\w]/g, "") || ".mp4";
    const input = path.join(dir, `input${ext}`);
    await streamPipeline(file.file, createWriteStream(input));
    if (file.file.truncated) return reply.code(413).send({ error: "File is larger than the upload limit" });

    store.create(id, file.filename);
    void runPipeline(id, input, { store, provider: opts.provider, dataDir: opts.dataDir });
    return reply.code(202).send({ id });
  });

  app.get<{ Params: { id: string } }>("/api/videos/:id", (req, reply) => {
    const job = ID_RE.test(req.params.id) ? store.get(req.params.id) : undefined;
    if (!job) return reply.code(404).send({ error: "Unknown video id" });
    return job;
  });

  // Server-Sent Events: replay what already happened, then stream live until the job ends.
  app.get<{ Params: { id: string } }>("/api/videos/:id/events", (req, reply) => {
    const job = ID_RE.test(req.params.id) ? store.get(req.params.id) : undefined;
    if (!job) return reply.code(404).send({ error: "Unknown video id" });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (e: JobEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

    job.events.forEach(send);
    if (isTerminal(job.stage)) return void res.end();

    const channel = `job:${job.id}`;
    const onEvent = (e: JobEvent) => {
      send(e);
      if (isTerminal(e.stage)) {
        cleanup();
        res.end();
      }
    };
    const cleanup = () => store.bus.off(channel, onEvent);
    store.bus.on(channel, onEvent);
    req.raw.on("close", cleanup);
  });

  // Only HLS output and clips are public. The original upload and the extracted audio are not.
  app.get<{ Params: { id: string; "*": string } }>("/media/:id/*", (req, reply) => {
    const { id, "*": rest } = req.params;
    if (!ID_RE.test(id) || !MEDIA_RE.test(rest)) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile(`${id}/${rest}`, opts.dataDir);
  });

  return { app, store };
}
