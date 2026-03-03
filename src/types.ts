// ─── Nova Modes ──────────────────────────────────────────────────────────────

/**
 * TACTICAL – mission/situational awareness tone.
 * BUILD    – engineering / maker mode.
 * SCAN     – analytical / reconnaissance tone.
 * SILENT   – suppresses all Nova responses (wake word still arms).
 */
export type NovaMode = "TACTICAL" | "BUILD" | "SCAN" | "SILENT";

// ─── Conversation History ─────────────────────────────────────────────────────

export interface Turn {
  role: "user" | "assistant";
  text: string;
}
