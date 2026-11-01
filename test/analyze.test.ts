import { describe, expect, it } from "vitest";
import { analyzeWithRetry } from "../src/analyze.js";
import type { AudioInput, LlmProvider } from "../src/llm/provider.js";
import { MockProvider } from "../src/llm/mock.js";
import { semanticIssues } from "../src/schema.js";

const audio: AudioInput = { path: "unused", mimeType: "audio/mp3" };

/** Provider that replays a fixed list of answers and records the feedback it was given. */
function scripted(answers: unknown[]): LlmProvider & { feedbackSeen: string[][] } {
  const feedbackSeen: string[][] = [];
  let i = 0;
  return {
    feedbackSeen,
    analyze: (_a, _d, feedback) => {
      feedbackSeen.push(feedback);
      return Promise.resolve(answers[Math.min(i++, answers.length - 1)]);
    },
    planClips: () => Promise.resolve([]),
  };
}

const valid = (d: number) => new MockProvider().analyze(audio, d);

describe("semanticIssues", () => {
  it("accepts the mock analysis", async () => {
    const a = (await valid(60)) as Parameters<typeof semanticIssues>[0];
    expect(semanticIssues(a, 60)).toEqual([]);
  });

  it("flags timestamps beyond the video, unordered chapters and bad clip lengths", async () => {
    const a = (await valid(60)) as Parameters<typeof semanticIssues>[0];
    a.chapters[1]!.start = 500;
    a.chapters[2]!.start = 400;
    a.highlights[0] = { start: 10, end: 11, title: "t", reason: "r" };
    const issues = semanticIssues(a, 60).join("\n");
    expect(issues).toContain("beyond the video duration");
    expect(issues).toContain("must be greater than the previous chapter");
    expect(issues).toContain("must be between");
  });
});

describe("no speech", () => {
  const silent = { hasSpeech: false, summary: "Instrumental music, no talking.", chapters: [], quiz: [], highlights: [] };

  it("accepts an analysis with no speech and empty lists", async () => {
    const out = await analyzeWithRetry(scripted([silent]), audio, 60);
    expect(out.attempts).toBe(1);
    expect(out.analysis.hasSpeech).toBe(false);
  });

  it("rejects a no-speech answer that still invents a quiz", async () => {
    const withQuiz = { ...((await valid(60)) as object), hasSpeech: false };
    const p = scripted([withQuiz, silent]);
    const out = await analyzeWithRetry(p, audio, 60);
    expect(out.attempts).toBe(2);
    expect(p.feedbackSeen[1]!.join("\n")).toContain("hasSpeech is false");
  });

  it("rejects speech with no chapters", async () => {
    const empty = { ...((await valid(60)) as object), chapters: [] };
    const p = scripted([empty, await valid(60)]);
    const out = await analyzeWithRetry(p, audio, 60);
    expect(p.feedbackSeen[1]!.join("\n")).toContain("at least one chapter");
    expect(out.attempts).toBe(2);
  });
});

describe("analyzeWithRetry", () => {
  it("accepts a valid first answer without retrying", async () => {
    const p = scripted([await valid(60)]);
    const out = await analyzeWithRetry(p, audio, 60);
    expect(out.attempts).toBe(1);
    expect(out.rejected).toEqual([]);
  });

  it("rejects schema-invalid output, feeds the reasons back, and accepts the corrected answer", async () => {
    const p = scripted([{ summary: "only a summary" }, await valid(60)]);
    const out = await analyzeWithRetry(p, audio, 60);
    expect(out.attempts).toBe(2);
    expect(out.rejected[0]!.length).toBeGreaterThan(0);
    expect(p.feedbackSeen[0]).toEqual([]);
    expect(p.feedbackSeen[1]!.join("\n")).toContain("chapters");
  });

  it("rejects well-typed output whose timestamps are past the end of the video", async () => {
    const bad = (await valid(60)) as { chapters: { start: number }[] };
    bad.chapters[2]!.start = 9999;
    const p = scripted([bad, await valid(60)]);
    const out = await analyzeWithRetry(p, audio, 60);
    expect(out.attempts).toBe(2);
    expect(p.feedbackSeen[1]!.join("\n")).toContain("beyond the video duration");
  });

  it("treats a provider that throws or returns garbage as a rejected attempt, not a dead job", async () => {
    let calls = 0;
    const flaky: LlmProvider = {
      analyze: async () => {
        calls++;
        if (calls === 1) throw new Error("429 rate limited");
        if (calls === 2) return "not json at all";
        return valid(60);
      },
      planClips: () => Promise.resolve([]),
    };
    const out = await analyzeWithRetry(flaky, audio, 60);
    expect(out.attempts).toBe(3);
    expect(out.rejected[0]![0]).toContain("429 rate limited");
    expect(out.rejected[1]![0]).toContain("expected object");
  });

  it("sends the previous rejected answer back together with the reasons", async () => {
    const seenPrevious: unknown[] = [];
    const bad = { hasSpeech: true, summary: "x", chapters: [], quiz: [], highlights: [] };
    const p: LlmProvider = {
      analyze: async (_a, d, _f, previous) => {
        seenPrevious.push(previous);
        return seenPrevious.length === 1 ? bad : valid(d);
      },
      planClips: () => Promise.resolve([]),
    };
    await analyzeWithRetry(p, audio, 60);
    expect(seenPrevious[0]).toBeUndefined();
    expect(seenPrevious[1]).toEqual(bad);
  });

  it("gives up after three bad answers instead of looping forever", async () => {
    const p = scripted([{ nope: true }]);
    await expect(analyzeWithRetry(p, audio, 60)).rejects.toThrow(/after 3 attempts/);
    expect(p.feedbackSeen).toHaveLength(3);
  });
});
