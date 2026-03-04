import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";
import type { NovaMode, Turn } from "./types.js";

// ─── Client factory ───────────────────────────────────────────────────────────

export function createNovaClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

// ─── Mode command parser ──────────────────────────────────────────────────────

const MODE_ALIASES: Record<string, NovaMode> = {
  tactical: "TACTICAL",
  build: "BUILD",
  scan: "SCAN",
  silent: "SILENT",
};

/**
 * If the utterance is a mode-switch command ("mode scan", "mode build", …)
 * return the target NovaMode; otherwise return null.
 */
export function parseModeCommand(text: string): NovaMode | null {
  const lower = text.trim().toLowerCase();
  const match = lower.match(/^mode\s+(\w+)$/);
  if (!match) return null;
  return MODE_ALIASES[match[1]!] ?? null;
}

// ─── Wake-word gating ─────────────────────────────────────────────────────────

/**
 * Decide whether this utterance should trigger a Nova response.
 *
 * Fires when any of the following is true:
 *   1. `wakeArmed` is true (the previous turn was the wake word alone).
 *   2. The text starts with the wake word (optionally followed by punctuation).
 *   3. The text exactly equals the wake word (bare invocation).
 */
export function shouldTriggerNova(
  userText: string,
  wakeWord: string,
  wakeArmed: boolean
): boolean {
  if (wakeArmed) return true;

  const lower = userText.trim().toLowerCase();
  const wake = wakeWord.toLowerCase();

  // Exact match (bare "nova")
  if (lower === wake) return true;

  // Starts with wake word followed by whitespace or punctuation
  const prefixRe = new RegExp(`^${escapeRegex(wake)}[\\s,!?.]+`, "i");
  return prefixRe.test(lower);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
`;

const MODE_RULES: Record<NovaMode, string> = {
  TACTICAL: `Mode: TACTICAL. Prioritise speed and brevity. Use imperative tense. Think mission-critical.`,
  BUILD: `Mode: BUILD. Favour technical precision. Mention relevant tools or patterns. Be constructive.`,
  SCAN: `Mode: SCAN. Analytical tone. Surface key facts, anomalies, or risks. Be objective.`,
  SILENT: `Mode: SILENT. Do not respond to any prompts. Output nothing.`,
};

export function buildNovaInstructions(mode: NovaMode): string {
  return `${BASE_INSTRUCTIONS}\n${MODE_RULES[mode]}`;
}

// ─── History formatting ───────────────────────────────────────────────────────

/**
 * Build the input string from the last 8 turns plus the current user message.
 */
export function historyToInput(history: Turn[], userText: string): string {
  const recent = history.slice(-8);
  const lines = recent.map((t) =>
    t.role === "user" ? `User: ${t.text}` : `Nova: ${t.text}`
  );
  lines.push(`User: ${userText}`);
  return lines.join("\n");
}

// ─── Ask Nova ─────────────────────────────────────────────────────────────────

interface AskNovaParams {
  openai: OpenAI;
  cfg: { model: string; wakeWord: string };
  mode: NovaMode;
  history: Turn[];
  userText: string;
}

/**
 * Call the OpenAI Responses API and return Nova's reply text.
 * Returns an empty string on any non-throwing edge case.
 */
export async function askNova({
  openai,
  cfg,
  mode,
  history,
  userText,
}: AskNovaParams): Promise<string> {
  // SILENT mode: never call the API.
  if (mode === "SILENT") return "";

  const params: ResponseCreateParamsNonStreaming = {
    model: cfg.model,
    reasoning: { effort: "low" },
    instructions: buildNovaInstructions(mode),
    input: historyToInput(history, userText),
  };

  const resp = await openai.responses.create(params);
  return (resp.output_text ?? "").trim();
}
