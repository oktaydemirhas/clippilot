import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GoogleGenAI } from "@google/genai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANALYSIS_JSON_SCHEMA, GeminiProvider } from "../src/llm/gemini.js";

interface Captured {
  params?: { contents: { parts: { text?: string }[] }[]; config: Record<string, unknown> };
}

/** A fake SDK: records the request and returns a canned response. */
function fakeClient(response: { text?: string; functionCalls?: { name?: string; args?: unknown }[] }, captured: Captured) {
  return {
    models: {
      generateContent: (params: Captured["params"]) => {
        captured.params = params;
        return Promise.resolve(response);
      },
    },
  } as unknown as Pick<GoogleGenAI, "models">;
}

describe("GeminiProvider", () => {
  let tmp: string;
  let audio: { path: string; mimeType: string };

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "clippilot-gemini-"));
    audio = { path: path.join(tmp, "a.mp3"), mimeType: "audio/mp3" };
    await writeFile(audio.path, Buffer.from("fake audio"));
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  it("asks the API to enforce the schema and passes the parsed JSON back unvalidated", async () => {
    const captured: Captured = {};
    const p = new GeminiProvider("k", "m", fakeClient({ text: '{"hasSpeech":false}' }, captured));
    expect(await p.analyze(audio, 30, [])).toEqual({ hasSpeech: false });
    expect(captured.params!.config.responseMimeType).toBe("application/json");
    expect(captured.params!.config.responseJsonSchema).toMatchObject({ type: "object" });
    expect(captured.params!.config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("does not send schema keywords the real API rejects (maxLength, maxItems gave a 400 on the live API)", () => {
    const sent = JSON.stringify(ANALYSIS_JSON_SCHEMA);
    expect(sent).not.toContain("maxLength");
    expect(sent).not.toContain("maxItems");
    expect(sent).toContain("hasSpeech"); // still the full shape
  });

  it("strips markdown fences around JSON", async () => {
    const p = new GeminiProvider("k", "m", fakeClient({ text: '```json\n{"a":1}\n```' }, {}));
    expect(await p.analyze(audio, 30, [])).toEqual({ a: 1 });
  });

  it("returns the raw text instead of throwing when the reply is not JSON or is empty, so the retry loop can react", async () => {
    const notJson = new GeminiProvider("k", "m", fakeClient({ text: "Sorry, I cannot do that" }, {}));
    expect(await notJson.analyze(audio, 30, [])).toBe("Sorry, I cannot do that");
    const empty = new GeminiProvider("k", "m", fakeClient({}, {}));
    expect(await empty.analyze(audio, 30, [])).toBe("");
  });

  it("includes the previous answer and the rejection reasons in the retry prompt", async () => {
    const captured: Captured = {};
    const p = new GeminiProvider("k", "m", fakeClient({ text: "{}" }, captured));
    await p.analyze(audio, 30, ["quiz[0].at=99 is beyond the video"], { quiz: [{ at: 99 }] });
    const prompt = captured.params!.contents[0]!.parts.map((x) => x.text ?? "").join("\n");
    expect(prompt).toContain("quiz[0].at=99 is beyond the video");
    expect(prompt).toContain('"at":99');
  });

  it("maps function calls to tool calls and only allows cut_clip", async () => {
    const captured: Captured = {};
    const p = new GeminiProvider(
      "k",
      "m",
      fakeClient({ functionCalls: [{ name: "cut_clip", args: { start: 1, end: 9, title: "t" } }, { args: {} }] }, captured),
    );
    const calls = await p.planClips({ hasSpeech: true, summary: "s", chapters: [], quiz: [], highlights: [] }, 30);
    expect(calls).toEqual([
      { name: "cut_clip", args: { start: 1, end: 9, title: "t" } },
      { name: "", args: {} },
    ]);
    const toolConfig = captured.params!.config.toolConfig as { functionCallingConfig: { allowedFunctionNames: string[] } };
    expect(toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(["cut_clip"]);
  });
});
