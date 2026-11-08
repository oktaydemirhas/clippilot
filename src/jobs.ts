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
  /** Empty for a pure progress tick: those only move the bar and are not kept in the job's history. */
  message: string;
  at: string;
  /** Overall progress, 0-100. */
  percent: number;
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
  percent: number;
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
    const job: Job = { id, stage: "queued", percent: 0, events: [] };
    this.jobs.set(id, job);
    this.push(job, "queued", "Upload received", 0);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  delete(id: string): void {
    this.jobs.delete(id);
    this.bus.removeAllListeners(`job:${id}`);
  }

  /** A new step. `percent` defaults to where the job already is, so a status note does not move the bar. */
  update(id: string, stage: Stage, message: string, percent?: number): void {
    const job = this.jobs.get(id);
    if (job) this.push(job, stage, message, percent ?? job.percent);
  }

  /** A progress tick inside the current step. Never goes backwards, never reaches 100 before the job is done. */
  progress(id: string, percent: number): void {
    const job = this.jobs.get(id);
    if (!job || isTerminal(job.stage)) return;
    const next = Math.min(99, Math.max(job.percent, Math.round(percent)));
    if (next === job.percent) return;
    job.percent = next;
    // Not kept in `events`: a long encode would otherwise fill the history that every new viewer replays.
    this.bus.emit(`job:${job.id}`, { stage: job.stage, message: "", at: new Date().toISOString(), percent: next } satisfies JobEvent);
  }

  complete(id: string, result: JobResult): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.result = result;
    this.push(job, "done", "Finished", 100);
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.error = error;
    this.push(job, "failed", error, job.percent);
  }

  private push(job: Job, stage: Stage, message: string, percent: number): void {
    job.stage = stage;
    job.percent = percent;
    const event: JobEvent = { stage, message, at: new Date().toISOString(), percent };
    job.events.push(event);
    this.bus.emit(`job:${job.id}`, event);
  }
}
