import { z } from "zod";

export const AnalysisSchema = z.object({
  /** False for music, silence or ambient sound: then chapters, quiz and highlights must be empty. */
  hasSpeech: z.boolean(),
  summary: z.string().min(1),
  chapters: z.array(z.object({ start: z.number().min(0), title: z.string().min(1), summary: z.string().min(1) })),
  quiz: z.array(
    z.object({
      at: z.number().min(0),
      question: z.string().min(1),
      options: z.array(z.string().min(1)).length(4),
      answerIndex: z.number().int().min(0).max(3),
      explanation: z.string().min(1),
    }),
  ),
  highlights: z.array(
    z.object({ start: z.number().min(0), end: z.number().min(0), title: z.string().min(1), reason: z.string() }),
  ),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** The one tool the model may call. Arguments are re-validated before FFmpeg ever runs. */
export const CutClipArgs = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  title: z.string().min(1).max(80),
});
export type CutClipArgs = z.infer<typeof CutClipArgs>;

export const MIN_CLIP_SEC = 3;
export const MAX_CLIP_SEC = 90;
export const MAX_CLIPS = 5;

/**
 * Schema-valid is not the same as correct: a model can return perfectly typed JSON
 * with timestamps past the end of the video. These checks return human-readable
 * problems that are fed back to the model on retry.
 */
export function semanticIssues(a: Analysis, durationSec: number): string[] {
  const issues: string[] = [];
  const limit = durationSec + 0.5;

  if (!a.hasSpeech) {
    if (a.chapters.length + a.quiz.length + a.highlights.length > 0) {
      issues.push("hasSpeech is false, so chapters, quiz and highlights must all be empty arrays");
    }
    return issues;
  }
  if (a.chapters.length === 0) issues.push("hasSpeech is true, so at least one chapter is required");

  a.chapters.forEach((c, i) => {
    if (c.start >= durationSec) issues.push(`chapters[${i}].start=${c.start} is beyond the video duration ${durationSec.toFixed(1)}s`);
    const prev = a.chapters[i - 1];
    if (prev && c.start <= prev.start) issues.push(`chapters[${i}].start=${c.start} must be greater than the previous chapter start ${prev.start}`);
  });
  const first = a.chapters[0];
  if (first && first.start > 10) issues.push(`the first chapter must start near 0, got ${first.start}`);

  a.quiz.forEach((q, i) => {
    if (q.at >= durationSec) issues.push(`quiz[${i}].at=${q.at} is beyond the video duration ${durationSec.toFixed(1)}s`);
  });

  a.highlights.forEach((h, i) => {
    if (h.end > limit) issues.push(`highlights[${i}].end=${h.end} is beyond the video duration ${durationSec.toFixed(1)}s`);
    const len = h.end - h.start;
    if (len < MIN_CLIP_SEC || len > MAX_CLIP_SEC) {
      issues.push(`highlights[${i}] length ${len.toFixed(1)}s must be between ${MIN_CLIP_SEC} and ${MAX_CLIP_SEC} seconds`);
    }
  });
  return issues;
}
