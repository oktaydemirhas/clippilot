import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { sweep } from "../src/janitor.js";
import { JobStore } from "../src/jobs.js";
import { Limiter } from "../src/limiter.js";

describe("loadConfig", () => {
  const base = { LLM_PROVIDER: "mock" };

  it("uses safe defaults: loopback host, one job at a time", () => {
    const c = loadConfig(base);
    expect(c.host).toBe("127.0.0.1");
    expect(c.maxConcurrentJobs).toBe(1);
    expect(c.maxUploadBytes).toBe(500 * 1024 * 1024);
  });

  it("rejects junk instead of turning it into NaN (which would disable the upload limit)", () => {
    expect(() => loadConfig({ ...base, MAX_UPLOAD_MB: "abc" })).toThrow(/MAX_UPLOAD_MB/);
    expect(() => loadConfig({ ...base, PORT: "99999" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, MAX_CONCURRENT_JOBS: "0" })).toThrow(/MAX_CONCURRENT_JOBS/);
  });

  it("requires a key for gemini and rejects unknown providers", () => {
    expect(() => loadConfig({})).toThrow(/GEMINI_API_KEY/);
    expect(() => loadConfig({ LLM_PROVIDER: "openai" })).toThrow(/LLM_PROVIDER/);
  });
});

describe("Limiter", () => {
  it("never runs more than `concurrency` tasks at once and refuses work when the queue is full", async () => {
    const limiter = new Limiter(2, 1);
    const tick = () => new Promise((r) => setTimeout(r, 10));
    const gates = [0, 1, 2].map(() => {
      let open!: () => void;
      const opened = new Promise<void>((r) => (open = r));
      return { open, opened };
    });
    const started: number[] = [];
    const runs = gates.map((g, i) =>
      limiter.run(async () => {
        started.push(i);
        await g.opened;
      }),
    );

    await tick();
    expect(started).toEqual([0, 1]); // the third waits for a free slot
    expect(limiter.queued).toBe(1);
    expect(limiter.canAccept()).toBe(false);

    gates[0]!.open();
    await tick();
    expect(started).toEqual([0, 1, 2]); // finishing one hands its slot to the queued task
    expect(limiter.queued).toBe(0);
    expect(limiter.canAccept()).toBe(true);

    gates[1]!.open();
    gates[2]!.open();
    await Promise.all(runs);
  });

  it("counts uploads that are still streaming in against the capacity", () => {
    const limiter = new Limiter(1, 1); // room for two jobs in total
    expect(limiter.canAccept(0)).toBe(true);
    expect(limiter.canAccept(1)).toBe(true);
    expect(limiter.canAccept(2)).toBe(false);
  });

  it("keeps working after a task throws", async () => {
    const limiter = new Limiter(1, 1);
    await expect(limiter.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await limiter.run(() => Promise.resolve("ok"))).toBe("ok");
  });
});

describe("sweep", () => {
  it("deletes old job directories, keeps fresh and running ones, and forgets the deleted jobs", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "clippilot-sweep-"));
    try {
      const store = new JobStore();
      const old = "00000000-0000-4000-8000-000000000001";
      const fresh = "00000000-0000-4000-8000-000000000002";
      const running = "00000000-0000-4000-8000-000000000003";
      for (const id of [old, fresh, running]) await mkdir(path.join(dataDir, id));
      // Not a job directory: an old unrelated folder must survive even if DATA_DIR points at a shared place.
      await mkdir(path.join(dataDir, "photos"));
      await utimes(path.join(dataDir, "photos"), new Date(0), new Date(0));
      store.create(old);
      store.complete(old, {} as never);
      store.create(running); // stays "queued"
      const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
      await utimes(path.join(dataDir, old), twoDaysAgo, twoDaysAgo);
      await utimes(path.join(dataDir, running), twoDaysAgo, twoDaysAgo);

      const removed = await sweep(store, dataDir, 24 * 3_600_000);
      expect(removed).toEqual([old]);
      expect((await readdir(dataDir)).sort()).toEqual([fresh, running, "photos"]);
      expect(store.get(old)).toBeUndefined();
      expect(store.get(running)).toBeDefined();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
