import { readFile } from "node:fs/promises";
import { FunctionCallingConfigMode, GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { type Analysis, AnalysisSchema } from "../schema.js";
import type { AudioInput, LlmProvider, ToolCall } from "./provider.js";

const ANALYSIS_JSON_SCHEMA = z.toJSONSchema(AnalysisSchema, { target: "draft-7" });

const ANALYSIS_SHAPE = `{
  "hasSpeech": boolean,                    // false for music, silence or ambient sound only
  "summary": string,                       // 2-4 sentences
  "chapters": [{ "start": number, "title": string, "summary": string }],
  "quiz": [{ "at": number, "question": string, "options": [string, string, string, string], "answerIndex": 0-3, "explanation": string }],
  "highlights": [{ "start": number, "end": number, "title": string, "reason": string }]
}`;

function analysisPrompt(durationSec: number, feedback: string[]): string {
  const lines = [
    "You are analysing the audio track of an educational video.",
    `The video is exactly ${durationSec.toFixed(1)} seconds long. Every timestamp is in seconds from the start and must be inside the video.`,
    "Listen to the audio and answer in the same language the speaker uses.",
    "Return ONLY a JSON object with exactly this shape:",
    ANALYSIS_SHAPE,
    "Rules:",
    "- Chapters are in ascending order and the first one starts at 0.",
    "- Quiz: 2-5 questions, each placed right after the moment the answer was explained (`at`). Exactly 4 options, only one correct. Base every question on what was actually said.",
    "- Highlights: 1-4 self-contained moments, each 5-60 seconds long, that work as standalone short clips.",
    "- Do not invent content that is not in the audio.",
    "- If there is no spoken content (music, silence, ambient sound), set hasSpeech to false, describe the audio in one sentence in `summary`, and return empty arrays for chapters, quiz and highlights.",
  ];
  if (feedback.length > 0) {
    lines.push(
      "Your previous answer was rejected for these reasons. Fix every one of them:",
      ...feedback.map((f) => `- ${f}`),
    );
  }
  return lines.join("\n");
}

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

export class GeminiProvider implements LlmProvider {
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async analyze(audio: AudioInput, durationSec: number, feedback: string[]): Promise<unknown> {
    const data = (await readFile(audio.path)).toString("base64");
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: audio.mimeType, data } }, { text: analysisPrompt(durationSec, feedback) }],
        },
      ],
      // The API enforces the shape; our zod schema still re-validates the answer afterwards.
      config: { responseMimeType: "application/json", responseJsonSchema: ANALYSIS_JSON_SCHEMA, temperature: 0.2 },
    });
    const text = res.text;
    if (!text) throw new Error("Gemini returned an empty response");
    try {
      return JSON.parse(stripFences(text));
    } catch {
      throw new Error(`Gemini did not return valid JSON: ${text.slice(0, 200)}`);
    }
  }

  async planClips(analysis: Analysis, durationSec: number): Promise<ToolCall[]> {
    const res = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                `A ${durationSec.toFixed(1)}-second educational video was analysed. Candidate highlights:`,
                JSON.stringify(analysis.highlights),
                "Decide which of them make the best standalone short clips (at most 3) and call cut_clip once per clip.",
                "You may tighten the boundaries, but start and end must stay inside the video.",
              ].join("\n"),
            },
          ],
        },
      ],
      config: {
        temperature: 0,
        tools: [
          {
            functionDeclarations: [
              {
                name: "cut_clip",
                description: "Cut a short standalone clip out of the video.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    start: { type: Type.NUMBER, description: "Start time in seconds" },
                    end: { type: Type.NUMBER, description: "End time in seconds" },
                    title: { type: Type.STRING, description: "Short clip title" },
                  },
                  required: ["start", "end", "title"],
                },
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: ["cut_clip"] } },
      },
    });
    return (res.functionCalls ?? []).map((c) => ({ name: c.name ?? "", args: c.args }));
  }
}
