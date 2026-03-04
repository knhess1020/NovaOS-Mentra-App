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
