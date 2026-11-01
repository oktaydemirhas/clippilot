import { describe, expect, it } from "vitest";
import { executeToolCalls } from "../src/clips.js";

function ctx(durationSec = 60) {
  const cuts: [string, number, number][] = [];
  return {
    cuts,
    ctx: {
      durationSec,
      clipsDir: "clips",
      cut: (out: string, s: number, e: number) => {
        cuts.push([out, s, e]);
        return Promise.resolve();
      },
    },
  };
}

describe("executeToolCalls", () => {
  it("cuts valid calls", async () => {
    const { ctx: c, cuts } = ctx();
    const { clips, rejected } = await executeToolCalls([{ name: "cut_clip", args: { start: 5, end: 20, title: "A" } }], c);
    expect(clips).toHaveLength(1);
    expect(rejected).toEqual([]);
    expect(cuts[0]![1]).toBe(5);
  });

  it("rejects unknown tools, malformed args, out-of-range starts and bad lengths without touching FFmpeg", async () => {
    const { ctx: c, cuts } = ctx(60);
    const { clips, rejected } = await executeToolCalls(
      [
        { name: "rm_rf", args: {} },
        { name: "cut_clip", args: { start: "five", end: 20, title: "A" } },
        { name: "cut_clip", args: { start: 100, end: 120, title: "A" } },
        { name: "cut_clip", args: { start: 10, end: 11, title: "too short" } },
        { name: "cut_clip", args: { start: 0, end: 59, title: "too long?" } },
      ],
      c,
    );
    expect(rejected.map((r) => r.reason)).toEqual([
      expect.stringContaining("unknown tool"),
      expect.stringContaining("start"),
      expect.stringContaining("beyond the video duration"),
      expect.stringContaining("must be between"),
    ]);
    // The last call (0-59s) is legitimate and is the only one that reaches FFmpeg.
    expect(clips).toHaveLength(1);
    expect(cuts).toHaveLength(1);
  });

  it("clamps an end time past the video to the video duration", async () => {
    const { ctx: c, cuts } = ctx(30);
    await executeToolCalls([{ name: "cut_clip", args: { start: 20, end: 45, title: "A" } }], c);
    expect(cuts[0]![2]).toBe(30);
  });

  it("caps the number of clips", async () => {
    const { ctx: c } = ctx(600);
    const calls = Array.from({ length: 8 }, (_, i) => ({ name: "cut_clip", args: { start: i * 20, end: i * 20 + 10, title: `c${i}` } }));
    const { clips, rejected } = await executeToolCalls(calls, c);
    expect(clips).toHaveLength(5);
    expect(rejected).toHaveLength(3);
  });
});
