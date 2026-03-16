// src/nova.ts
import OpenAI from "openai";
import type { NovaMode, Turn } from "./types.js";

type NovaConfig = {
  model: string;
  wakeWord: string;
};

export function createNovaClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

// ─── System instructions ──────────────────────────────────────────────────────

const BASE_INSTRUCTIONS = `\
You are Nova — a smart-glasses AI assistant.

Style rules (non-negotiable):
- Reply in 1–3 short lines maximum.
- No explanations, no reasoning aloud, no "because" unless explicitly asked.
- No filler phrases ("Sure!", "Of course", "Great question").
- If the request is ambiguous, ask exactly ONE clarifying question and stop.
- Use plain language. Abbreviate when safe.
- Output ONLY the answer. No headings. No bullets unless the user asked for steps.
`;

const MODE_RULES: Record<NovaMode, string> = {
  TACTICAL:
    "Mode: TACTICAL. Single best next action. Imperative. Mission-critical.",
  BUILD:
    "Mode: BUILD. Technical, stepwise, but still short. Mention tools/settings when useful.",
  SCAN:
    "Mode: SCAN. Observe → hypothesize → propose ONE test. Objective, concise.",
  SILENT:
    "Mode: SILENT. Output nothing. (Caller should avoid API calls in SILENT.)",
};

export function buildNovaInstructions(mode: NovaMode): string {
  return `${BASE_INSTRUCTIONS}\n${MODE_RULES[mode]}`;
}

// ─── Mode command parser ──────────────────────────────────────────────────────

export function parseModeCommand(text: string): NovaMode | null {
  const lower = text.trim().toLowerCase();
  const m = lower.match(/^mode\s+(tactical|build|scan|silent)\b/);
  if (!m) return null;
  const key = m[1];
  if (key === "tactical") return "TACTICAL";
  if (key === "build") return "BUILD";
  if (key === "scan") return "SCAN";
  if (key === "silent") return "SILENT";
  return null;
}

// ─── Wake-word gating ─────────────────────────────────────────────────────────

export function shouldTriggerNova(
  userText: string,
  wakeWord: string,
  wakeArmed: boolean
): boolean {
  if (wakeArmed) return true;

  const t = userText.trim().toLowerCase();
  const w = wakeWord.trim().toLowerCase();
  if (!w) return true;

  if (t === w) return true;
  return (
    t.startsWith(`${w} `) ||
    t.startsWith(`${w},`) ||
    t.startsWith(`${w}:`) ||
    t.startsWith(`${w}.`) ||
    t.startsWith(`${w}!`) ||
    t.startsWith(`${w}?`)
  );
}

// ─── History formatting ───────────────────────────────────────────────────────

export function historyToInput(history: Turn[], userText: string): string {
  const recent = history.slice(-8);
  const ctx = recent
    .map((t) => `${t.role === "user" ? "User" : "Nova"}: ${t.text}`)
    .join("\n");
  return ctx ? `${ctx}\nUser: ${userText}` : userText;
}

// ─── Non-streaming call (fallback) ───────────────────────────────────────────

export async function askNova(params: {
  openai: OpenAI;
  cfg: NovaConfig;
  mode: NovaMode;
  history: Turn[];
  userText: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { openai, cfg, mode, history, userText, signal } = params;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = await (openai.responses as any).create(
    {
      model: cfg.model,
      reasoning: { effort: "low" },
      instructions: buildNovaInstructions(mode),
      input: historyToInput(history, userText),
    },
    { signal }
  );

  return ((resp.output_text as string | undefined) ?? "").trim();
}

// ─── Vision prompts ───────────────────────────────────────────────────────────

const VISION_SCENE_PROMPT =
  "Describe what you see concisely. Be specific and practical — " +
  "you are briefing a field operator wearing smart glasses. " +
  "Respond in 1–3 short sentences. No poetic language. Focus on what matters.";

const VISION_OCR_PROMPT =
  "The user wants to read text from the image.\n" +
  "Extract and return the visible text clearly. Focus on:\n" +
  "- screens\n" +
  "- labels\n" +
  "- printed text\n" +
  "- handwritten text if visible\n\n" +
  "Return only the readable text. Do not describe the scene.\n" +
  'If no text is visible, say "No readable text found."';

const VISION_INTERPRET_PROMPT =
  "The user wants help understanding what is shown in the image.\n" +
  "Focus on:\n" +
  "- errors\n" +
  "- warnings\n" +
  "- key messages\n" +
  "- screens\n" +
  "- dashboards\n" +
  "- anything important or abnormal\n\n" +
  "Respond in 1–3 concise sentences. If text is visible, interpret the important parts " +
  "instead of reading every word. If nothing important is visible, say so clearly.\n" +
  'If no meaningful interpretation is possible, say "I don\'t see anything important or clear enough to interpret."';

/**
 * Extracts the assistant text from whatever shape the OpenAI SDK returns.
 *
 * Tried in order:
 *   1. Chat Completions standard  → choices[0].message.content  (string)
 *   2. Chat Completions new-model → choices[0].message.content  (array of {type,text} blocks)
 *   3. Responses API flat         → output_text                 (string)
 *   4. Responses API nested       → output[0].content[*].text   (string)
 *
 * Newer models (gpt-5, o-series) routed through chat.completions return a
 * Responses-API-shaped object where choices[0].message.content is null;
 * the text lives in output_text or output[].content[].text instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractVisionText(response: any): string {
  // ── 1 & 2: Chat Completions shape ────────────────────────────────────────
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        (block?.type === "text" || block?.type === "output_text") &&
        typeof block?.text === "string" &&
        block.text.trim()
      ) {
        return block.text.trim();
      }
    }
  }

  // ── 3: Responses API flat ─────────────────────────────────────────────────
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  // ── 4: Responses API nested ───────────────────────────────────────────────
  if (Array.isArray(response?.output)) {
    for (const item of response.output) {
      if (typeof item?.text === "string" && item.text.trim()) {
        return item.text.trim();
      }
      if (Array.isArray(item?.content)) {
        for (const block of item.content) {
          if (typeof block?.text === "string" && block.text.trim()) {
            return block.text.trim();
          }
        }
      }
    }
  }

  return "";
}

/**
 * Single-shot vision call using the Chat Completions multimodal API.
 * Uses the same model as text queries; requires a vision-capable model
 * (e.g. gpt-4o, gpt-5). Set OPENAI_MODEL accordingly.
 */
export async function askNovaVision(params: {
  openai: OpenAI;
  cfg: NovaConfig;
  mode: NovaMode;
  imageBuffer: Buffer;
  mimeType: string;
  visionMode: "scene" | "ocr" | "interpret";
  signal?: AbortSignal;
}): Promise<string> {
  const { openai, cfg, mode, imageBuffer, mimeType, visionMode, signal } = params;

  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const userPrompt =
    visionMode === "ocr"
      ? VISION_OCR_PROMPT
      : visionMode === "interpret"
      ? VISION_INTERPRET_PROMPT
      : VISION_SCENE_PROMPT;
  const systemContent = `${BASE_INSTRUCTIONS}\n${MODE_RULES[mode]}`;

  console.log("[Nova] Sending vision request", { model: cfg.model, hasImage: true });

  const response = await openai.chat.completions.create(
    {
      model: cfg.model,
      max_completion_tokens: 300,
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
          ],
        },
      ],
    },
    { signal }
  );

  console.log("[Nova] Vision analysis succeeded");

  // Log response shape (safe — no base64 re-logged) to aid future debugging.
  console.log("[Nova] Vision response shape:", {
    choices_count: response?.choices?.length ?? 0,
    content_type: typeof response?.choices?.[0]?.message?.content,
    content_is_array: Array.isArray(response?.choices?.[0]?.message?.content),
    has_output_text: typeof (response as any)?.output_text,
    output_length: (response as any)?.output?.length ?? 0,
  });

  const extracted = extractVisionText(response);
  console.log("[Nova] Extracted vision text:", extracted || "(empty)");
  return extracted;
}

// ─── Streaming call ───────────────────────────────────────────────────────────

/**
 * Streams a Nova reply, calling `onDelta` with each incremental text chunk.
 * Returns the full final text. Falls back to non-streaming if unavailable.
 */
export async function askNovaStream(params: {
  openai: OpenAI;
  cfg: NovaConfig;
  mode: NovaMode;
  history: Turn[];
  userText: string;
  onDelta: (deltaText: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { openai, cfg, mode, history, userText, onDelta, signal } = params;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const responsesAny = openai.responses as any;

  // ── Path A: openai.responses.stream (preferred) ───────────────────────────
  if (typeof responsesAny.stream === "function") {
    const stream: AsyncIterable<unknown> = responsesAny.stream(
      {
        model: cfg.model,
        reasoning: { effort: "low" },
        instructions: buildNovaInstructions(mode),
        input: historyToInput(history, userText),
      },
      { signal }
    ) as AsyncIterable<unknown>;

    let full = "";

    for await (const event of stream) {
      // Responses streaming event shapes:
      //   { type: "response.output_text.delta", delta: "..." }
      //   { type: "response.output_text.delta", delta: { text: "..." } }
      const ev = event as Record<string, unknown>;
      const type = typeof ev["type"] === "string" ? ev["type"] : "";

      if (type.includes("output_text") && type.includes("delta")) {
        const raw = ev["delta"];
        const d =
          typeof raw === "string"
            ? raw
            : typeof (raw as Record<string, unknown>)?.["text"] === "string"
            ? ((raw as Record<string, unknown>)["text"] as string)
            : typeof ev["text"] === "string"
            ? (ev["text"] as string)
            : "";

        if (d) {
          full += d;
          onDelta(d);
        }
      }
    }

    return full.trim();
  }

  // ── Path B: fallback to non-streaming ─────────────────────────────────────
  return await askNova({ openai, cfg, mode, history, userText, signal });
}

// ─── Web search lookup ────────────────────────────────────────────────────────

export interface WebLookupResult {
  answer: string;
  sources: Array<{ title: string; url: string }>;
}

/**
 * Performs a live web lookup using the OpenAI Responses API with the
 * built-in `web_search` tool.
 *
 * Requires a model that supports web_search (e.g. gpt-4o, gpt-4o-mini).
 * Pass `model` from the caller; default is controlled by SEARCH_MODEL env var.
 *
 * Optional location context is injected into the query so proximity-sensitive
 * queries (weather, nearby businesses, open/closed status) work correctly.
 */
export async function lookupWithWebSearch(params: {
  openai: OpenAI;
  model: string;
  query: string;
  userTimezone?: string;
  userCity?: string;
  userRegion?: string;
  userCountry?: string;
  signal?: AbortSignal;
}): Promise<WebLookupResult> {
  const {
    openai, model, query,
    userTimezone, userCity, userRegion, userCountry, signal,
  } = params;

  // Build a location hint to anchor proximity-dependent queries.
  const locationParts: string[] = [];
  if (userCity)    locationParts.push(userCity);
  if (userRegion)  locationParts.push(userRegion);
  if (userCountry) locationParts.push(userCountry);
  const locationHint =
    locationParts.length > 0
      ? locationParts.join(", ")
      : userTimezone
      ? `timezone ${userTimezone}`
      : null;

  const instructions = [
    "You are a concise assistant on smart glasses answering real-time factual queries.",
    "Reply in 1–3 short sentences. Be specific and practical.",
    "For businesses: include name, phone number, and hours if found.",
    "For weather: give current temperature and conditions.",
    "Never include raw URLs in your answer. Just the facts.",
    locationHint ? `User is located near: ${locationHint}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const input = locationHint
    ? `User location context: ${locationHint}.\n\nQuery: ${query}`
    : query;

  console.log("[Nova] Web search model:", model, "| query:", query);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp = await (openai.responses as any).create(
    {
      model,
      tools: [{ type: "web_search" }],
      instructions,
      input,
    },
    { signal }
  );

  // ── Extract answer text (Responses API flat shortcut) ──────────────────────
  const answer = ((resp.output_text as string | undefined) ?? "").trim();

  // ── Extract sources from output item annotations ───────────────────────────
  // Responses API shape for web_search citations:
  //   output[i].content[j].annotations[k].type === "url_citation"
  //   → { url: string; title?: string; start_index: number; end_index: number }
  const sources: Array<{ title: string; url: string }> = [];
  if (Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (Array.isArray(item?.content)) {
        for (const block of item.content) {
          if (Array.isArray(block?.annotations)) {
            for (const ann of block.annotations) {
              if (ann?.type === "url_citation" && typeof ann?.url === "string") {
                sources.push({
                  title: typeof ann.title === "string" ? ann.title : ann.url,
                  url: ann.url,
                });
              }
            }
          }
        }
      }
    }
  }

  return { answer, sources };
}
