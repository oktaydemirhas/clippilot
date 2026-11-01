import { EventEmitter } from "node:events";
import type { ClipInfo, RejectedCall } from "./clips.js";
import type { Analysis } from "./schema.js";

export type Stage =
  | "queued"
  | "probing"
  | "transcoding"
  | "extracting_audio"
  | "analyzing"
  | "cutting_clips"
  | "done"
  | "failed";

export interface JobEvent {
  stage: Stage;
  message: string;
  at: string;
}

export interface JobResult {
  durationSec: number;
  hlsUrl: string;
  analysis: Analysis;
  /** How many model answers it took to get a valid analysis (1 = first try). */
  analysisAttempts: number;
  /** Why earlier answers were rejected. */
  rejectedAnalyses: string[][];
  clips: (ClipInfo & { url: string })[];
  rejectedToolCalls: RejectedCall[];
}

export interface Job {
  id: string;
  stage: Stage;
  events: JobEvent[];
  result?: JobResult;
  error?: string;
}

export const isTerminal = (s: Stage) => s === "done" || s === "failed";

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  readonly bus = new EventEmitter();

  /** The original file name is deliberately not stored: it can contain personal data and nothing needs it. */
  create(id: string): Job {
    const job: Job = { id, stage: "queued", events: [] };
    this.jobs.set(id, job);
    this.push(job, "queued", "Upload received");
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  delete(id: string): void {
    this.jobs.delete(id);
    this.bus.removeAllListeners(`job:${id}`);
  }

  update(id: string, stage: Stage, message: string): void {
    const job = this.jobs.get(id);
    if (job) this.push(job, stage, message);
  }

  complete(id: string, result: JobResult): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.result = result;
    this.push(job, "done", "Finished");
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.error = error;
    this.push(job, "failed", error);
  }

  private push(job: Job, stage: Stage, message: string): void {
    job.stage = stage;
    const event: JobEvent = { stage, message, at: new Date().toISOString() };
    job.events.push(event);
    this.bus.emit(`job:${job.id}`, event);
  }
}
