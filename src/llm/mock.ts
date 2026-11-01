import type { Analysis } from "../schema.js";
import type { AudioInput, LlmProvider, ToolCall } from "./provider.js";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Deterministic stand-in for tests and offline demos. It never looks at the audio. */
export class MockProvider implements LlmProvider {
  analyze(_audio: AudioInput, durationSec: number): Promise<unknown> {
    const d = durationSec;
    const len = clamp(d * 0.25, 3, 20);
    const analysis: Analysis = {
      hasSpeech: true,
      summary: "Mock summary: this is a deterministic placeholder analysis.",
      chapters: [
        { start: 0, title: "Introduction", summary: "Opening section." },
        { start: d / 3, title: "Main idea", summary: "Middle section." },
        { start: (2 * d) / 3, title: "Wrap-up", summary: "Closing section." },
      ],
      quiz: [
        {
          at: d * 0.3,
          question: "Mock question: which section just played?",
          options: ["Introduction", "Main idea", "Wrap-up", "None of them"],
          answerIndex: 0,
          explanation: "Mock explanation.",
        },
      ],
      highlights: [
        { start: d * 0.1, end: Math.min(d * 0.1 + len, d), title: "First highlight", reason: "mock" },
        { start: d * 0.6, end: Math.min(d * 0.6 + len, d), title: "Second highlight", reason: "mock" },
      ],
    };
    return Promise.resolve(analysis);
  }

  planClips(analysis: Analysis): Promise<ToolCall[]> {
    return Promise.resolve(
      analysis.highlights.map((h) => ({ name: "cut_clip", args: { start: h.start, end: h.end, title: h.title } })),
    );
  }
}
