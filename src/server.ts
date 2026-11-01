import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { isTerminal, type JobEvent, JobStore } from "./jobs.js";
import { Limiter } from "./limiter.js";
import type { LlmProvider } from "./llm/provider.js";
import { runPipeline } from "./pipeline.js";

export interface ServerOptions {
  provider: LlmProvider;
  dataDir: string;
  maxUploadBytes: number;
  publicDir: string;
  maxDurationSec: number;
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
}

const ID_RE = /^[0-9a-f-]{36}$/;
// An explicit allowlist of what FFmpeg writes. `..` and anything else can never match.
const MEDIA_RE = /^(hls\/(index\.m3u8|seg_\d{3,}\.ts)|clips\/clip-\d+\.mp4)$/;

/** Everything the page loads comes from this origin; hls.js is served from /vendor, not a CDN. */
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; " +
    "worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; object-src 'none'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function buildServer(opts: ServerOptions): { app: FastifyInstance; store: JobStore } {
  const app = Fastify({ logger: false });
  const store = new JobStore();
  const limiter = new Limiter(opts.maxConcurrentJobs, opts.maxQueuedJobs);
  const hlsJsDir = path.dirname(createRequire(import.meta.url).resolve("hls.js/dist/hls.min.js"));

  app.addHook("onSend", (_req, reply, payload, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) void reply.header(name, value);
    done(null, payload);
  });

  void app.register(multipart, { limits: { fileSize: opts.maxUploadBytes, files: 1 } });
  void app.register(fastifyStatic, { root: opts.publicDir });
  void app.register(fastifyStatic, { root: hlsJsDir, prefix: "/vendor/", decorateReply: false });

  app.post("/api/videos", async (req, reply) => {
    if (!limiter.canAccept()) {
      return reply.code(503).header("Retry-After", "60").send({ error: "The server is busy. Try again in a few minutes" });
    }
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "Send the video as multipart/form-data" });
    // The declared type is only a quick filter: browsers report "" or octet-stream for some containers.
    // The real check is what ffprobe finds in the content (see the pipeline).
    const declared = file.mimetype;
    if (declared !== "" && declared !== "application/octet-stream" && !declared.startsWith("video/")) {
      file.file.resume();
      return reply.code(415).send({ error: "Expected a video file" });
    }

    const id = randomUUID();
    const dir = path.join(opts.dataDir, id);
    await mkdir(dir, { recursive: true });
    // The client's file name never touches the file system: FFmpeg sniffs the format from the content anyway.
    const input = path.join(dir, "input.bin");
    try {
      await streamPipeline(file.file, createWriteStream(input));
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      const tooLarge = (err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE";
      return reply.code(tooLarge ? 413 : 400).send({ error: tooLarge ? "File is larger than the upload limit" : "Upload failed" });
    }
    if (file.file.truncated) {
      await rm(dir, { recursive: true, force: true });
      return reply.code(413).send({ error: "File is larger than the upload limit" });
    }

    store.create(id);
    void limiter.run(() =>
      runPipeline(id, input, {
        store,
        provider: opts.provider,
        dataDir: opts.dataDir,
        maxDurationSec: opts.maxDurationSec,
      }),
    );
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
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
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
