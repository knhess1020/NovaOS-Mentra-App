// src/index.ts
import "dotenv/config";
import { AppServer, type Session, type AuthenticatedRequest, type PhotoData } from "@mentra/sdk";
import type { Response } from "express";

import {
  createNovaClient,
  parseModeCommand,
  shouldTriggerNova,
  askNovaStream,
  askNovaVision,
  lookupWithWebSearch,
  type WebLookupResult,
} from "./nova.js";

import {
  getSessionState,
  setMode,
  pushTurn,
  clearSession,
  armWake,
  consumeWakeArm,
  isWakeArmed,
  getWakeArmRemainingMs,
  disarmIfExpired,
} from "./memory.js";

// ─────────────────────────────────────────────────────────────────────────────
// Env helpers
// ─────────────────────────────────────────────────────────────────────────────
function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Required env
// ─────────────────────────────────────────────────────────────────────────────
const PACKAGE_NAME = requireEnv("PACKAGE_NAME");
const MENTRAOS_API_KEY = requireEnv("MENTRAOS_API_KEY");
const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const CFG = {
  model: process.env["OPENAI_MODEL"] ?? "gpt-5",
  // gpt-5 does not support image_url through chat.completions; use a dedicated
  // vision-capable model.  Override with VISION_MODEL env var if needed.
  visionModel: process.env["VISION_MODEL"] ?? "gpt-4o",
  // web_search tool requires a model that supports it (gpt-4o confirmed).
  // Override with SEARCH_MODEL env var if needed.
  webSearchModel: process.env["SEARCH_MODEL"] ?? "gpt-4o",
  wakeWord: (process.env["WAKE_WORD"] ?? "nova").toLowerCase(),
  port: envInt("PORT", 3000),

  wakeArmMs: envInt("WAKE_ARM_MS", 8000),
  streamUpdateMs: envInt("STREAM_UPDATE_MS", 250),

  ttsModel: process.env["TTS_MODEL"] ?? "eleven_flash_v2_5",
  ttsVoiceId: process.env["TTS_VOICE_ID"] || undefined,
  ttsMaxChars: envInt("TTS_MAX_CHARS", 1200),

  speakBootGreeting: envBool("SPEAK_BOOT_GREETING", false),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI client
// ─────────────────────────────────────────────────────────────────────────────
const openai = createNovaClient(OPENAI_API_KEY);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripWakePrefix(text: string, wakeWord: string): string {
  const re = new RegExp(`^${escapeRegex(wakeWord)}[\\s,:!?.-]*`, "i");
  const stripped = text.replace(re, "").trim();
  return stripped.length > 0 ? stripped : text.trim();
}

function normalizeWakeText(text: string): string {
  return text.trim().toLowerCase().replace(/[.,!?;:]+$/, "");
}

function isBareWake(text: string, wakeWord: string): boolean {
  return normalizeWakeText(text) === wakeWord.trim().toLowerCase();
}

function isTimeQuery(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes("what time") ||
    lower.includes("current time") ||
    lower.includes("what's the time") ||
    lower.includes("whats the time")
  );
}

function isBatteryQuery(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes("battery status") ||
    lower.includes("battery check") ||
    lower.includes("battery level") ||
    lower.includes("how much battery") ||
    lower.includes("status battery")
  );
}

function isConnectionQuery(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes("connection status") ||
    lower.includes("network status") ||
    lower.includes("are you connected") ||
    lower.includes("wifi status")
  );
}

function isSessionQuery(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes("session status") ||
    lower.includes("session uptime") ||
    lower.includes("how long have you been running")
  );
}

function isVisionQuery(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes("what am i looking at") ||
    lower.includes("look at this") ||
    lower.includes("describe what you see") ||
    lower.includes("what do you see") ||
    lower.includes("what is this") ||
    lower.includes("what's this")
  );
}

function isOcrQuery(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes("read this") ||
    lower.includes("read that") ||
    lower.includes("read the screen") ||
    lower.includes("read the label") ||
    lower.includes("read the sign") ||
    lower.includes("read the error") ||
    lower.includes("read the text") ||
    lower.includes("what does this say") ||
    lower.includes("what does that say") ||
    lower.includes("what does it say")
  );
}

function isInterpretQuery(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes("what does this mean") ||
    lower.includes("explain this") ||
    lower.includes("summarize this") ||
    lower.includes("summarize this screen") ||
    lower.includes("what's this error") ||
    lower.includes("whats this error") ||
    lower.includes("what is this error") ||
    lower.includes("is anything important here") ||
    lower.includes("what's wrong with this") ||
    lower.includes("whats wrong with this") ||
    lower.includes("what is wrong with this")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone action intent helpers
// ─────────────────────────────────────────────────────────────────────────────

function isCallIntent(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return /^(call|dial|phone)\s+\S/.test(lower);
}

function isTextIntent(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    /^text\s+\S/.test(lower) ||
    /^message\s+\S/.test(lower) ||
    /^send\s+(a\s+|an\s+)?(message|text|msg)\s+(to\s+)?\S/.test(lower)
  );
}

/** Strips the action verb prefix and returns everything after it as the target. */
function parseCallTarget(text: string): string {
  return text.trim().replace(/^(call|dial|phone)\s+/i, "").trim();
}

/** Returns the first word after "text"/"message", or the name after "send ... to". */
function parseTextRecipient(text: string): string | null {
  let m = text.match(/^(?:text|message)\s+(\S+)/i);
  if (m) return m[1];
  m = text.match(/^send\s+(?:a\s+|an\s+)?(?:message|text|msg)\s+to\s+(\S+)/i);
  if (m) return m[1];
  return null;
}

/** Returns everything after "text <recipient> " as the message body, or null. */
function parseTextMessage(text: string, recipient: string): string | null {
  const esc = recipient.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`^(?:text|message)\\s+${esc}\\s+(.+)$`, "i"));
  return m ? m[1].trim() : null;
}

/** Extracts the first US-style phone number found in a string. */
function extractPhoneNumber(text: string): string | null {
  const m = text.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
  return m ? m[0] : null;
}

function isConfirmation(text: string): boolean {
  const lower = text.trim().toLowerCase().replace(/[.,!?]+$/, "");
  const exact = [
    "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm",
    "go ahead", "do it", "send it", "call", "call them", "send",
    "yes please", "sounds good", "let's do it", "lets do it",
  ];
  return exact.includes(lower) || lower.startsWith("yes ") || lower.startsWith("yeah ");
}

function isCancellation(text: string): boolean {
  const lower = text.trim().toLowerCase().replace(/[.,!?]+$/, "");
  const exact = [
    "no", "nope", "cancel", "never mind", "nevermind",
    "forget it", "don't", "dont", "abort", "stop it", "no thanks",
  ];
  return exact.includes(lower) || lower.startsWith("no ") || lower.startsWith("cancel ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Voice profiles
// ─────────────────────────────────────────────────────────────────────────────

type VoiceProfile = "default" | "calm" | "tactical" | "scifi";

// Built once at startup from env vars.  All values may be undefined if the
// corresponding env var is not set — the TTS endpoint omits voice_id in that
// case and falls back to its own default.
//
// .env example:
//   TTS_VOICE_DEFAULT=21m00Tcm4TlvDq8ikWAM
//   TTS_VOICE_CALM=EXAVITQu4vr4xnSDxMaL
//   TTS_VOICE_TACTICAL=pNInz6obpgDQGcFmaJgB
//   TTS_VOICE_SCIFI=TxGEqnHWrfWFTfGW9XjX
const VOICE_PROFILES: Record<VoiceProfile, string | undefined> = {
  // TTS_VOICE_DEFAULT takes priority; TTS_VOICE_ID kept for backward compat.
  default:  process.env["TTS_VOICE_DEFAULT"] || process.env["TTS_VOICE_ID"] || undefined,
  calm:     process.env["TTS_VOICE_CALM"]     || undefined,
  tactical: process.env["TTS_VOICE_TACTICAL"] || undefined,
  scifi:    process.env["TTS_VOICE_SCIFI"]    || undefined,
};

const VOICE_LABELS: Record<VoiceProfile, string> = {
  default:  "Default",
  calm:     "Calm",
  tactical: "Tactical",
  scifi:    "Sci-Fi",
};

/** Returns true when the utterance is a request to switch voice profile. */
function isVoiceCommand(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes("calm voice") ||
    lower.includes("tactical voice") ||
    lower.includes("sci-fi voice") ||
    lower.includes("scifi voice") ||
    lower.includes("default voice") ||
    (lower.includes("switch to") && lower.includes("voice"))
  );
}

/** Extracts the requested VoiceProfile from the utterance, or null. */
function parseVoiceProfile(text: string): VoiceProfile | null {
  const lower = text.trim().toLowerCase();
  if (lower.includes("calm"))                          return "calm";
  if (lower.includes("tactical"))                      return "tactical";
  if (lower.includes("sci-fi") || lower.includes("scifi")) return "scifi";
  if (lower.includes("default"))                       return "default";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query routing helpers
// ─────────────────────────────────────────────────────────────────────────────

// ── Lane 1: local help ────────────────────────────────────────────────────────

/** True when the user is asking about Nova's capabilities or how to use a feature. */
function isHelpQuery(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower === "help" ||
    lower.includes("what can you do") ||
    lower.includes("what do you do") ||
    lower.includes("your features") ||
    lower.includes("your capabilities") ||
    lower.includes("what commands") ||
    lower.includes("list commands") ||
    lower.includes("how do i switch voice") ||
    lower.includes("how do i change voice") ||
    lower.includes("switch voice mode") ||
    lower.includes("change voice mode") ||
    lower.includes("how do i use vision") ||
    lower.includes("how do i use the camera") ||
    lower.includes("vision mode help") ||
    lower.includes("how do i use you") ||
    lower.includes("how do i talk to you") ||
    lower.includes("how do i wake you") ||
    lower.includes("wake word help")
  );
}

/**
 * Returns a short, spoken-friendly answer for help queries.
 * Checks for sub-topic first; falls back to a general capabilities summary.
 */
function answerHelpQuery(text: string): string {
  const lower = text.trim().toLowerCase();

  // Voice switching
  if (
    lower.includes("switch voice") ||
    lower.includes("change voice") ||
    lower.includes("voice mode") ||
    lower.includes("voice command") ||
    lower.includes("voice profile")
  ) {
    return "Say 'calm voice', 'tactical voice', 'sci-fi voice', or 'default voice' to switch.";
  }

  // Vision / camera / OCR / interpret
  if (
    lower.includes("vision") ||
    lower.includes("camera") ||
    lower.includes("read text") ||
    lower.includes("ocr") ||
    lower.includes("look at") ||
    lower.includes("what am i")
  ) {
    return (
      "Say 'what am I looking at' to describe a scene, " +
      "'read this' to extract text, or 'explain this' to interpret a screen."
    );
  }

  // Wake word / how to use
  if (
    lower.includes("wake word") ||
    lower.includes("how do i use you") ||
    lower.includes("how do i talk to you") ||
    lower.includes("how do i wake")
  ) {
    return "Say 'Nova' alone to arm me, then ask your question. Or lead directly with 'Nova' followed by your question.";
  }

  // General capabilities (default)
  return (
    "I can answer questions, tell the time, check battery and connection status, " +
    "switch voice profiles, describe scenes, read text, and interpret screens. " +
    "Just say 'Nova' to get started."
  );
}

// ── Lane 2: live lookup ────────────────────────────────────────────────────────

/**
 * True when the query requires current real-world data that cannot be reliably
 * answered from LLM memory (phone numbers, hours, weather, open/closed status).
 */
function isLiveLookupQuery(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return (
    lower.includes("phone number") ||
    lower.includes("what are the hours") ||
    lower.includes("store hours") ||
    lower.includes("what's the weather") ||
    lower.includes("whats the weather") ||
    lower.includes("what is the weather") ||
    lower.includes("current weather") ||
    lower.includes("is it going to rain") ||
    lower.includes("will it rain") ||
    (lower.includes("is ") && lower.includes(" open")) ||
    lower.includes("where is the nearest") ||
    lower.includes("where is the closest") ||
    lower.includes("directions to") ||
    lower.includes("how do i get to")
  );
}

/**
 * Performs a live web lookup using the OpenAI Responses API web_search tool.
 *
 * Accepts optional location context (timezone, city, region, country) to
 * anchor proximity-sensitive queries (weather, nearby business hours, etc.).
 * Returns the answer text and any source citations extracted from the response.
 */
async function doLiveLookup(params: {
  userText: string;
  timezone?: string;
  city?: string;
  region?: string;
  country?: string;
}): Promise<WebLookupResult> {
  const { userText, timezone, city, region, country } = params;
  console.log("[Nova] Routed to live web lookup:", userText);
  return lookupWithWebSearch({
    openai,
    model: CFG.webSearchModel,
    query: userText,
    userTimezone: timezone,
    userCity: city,
    userRegion: region,
    userCountry: country,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversational cues
// ─────────────────────────────────────────────────────────────────────────────

type CueType =
  | "time"
  | "battery"
  | "connection"
  | "uptime"
  | "help"
  | "live_lookup"
  | "vision_scene"
  | "vision_ocr"
  | "vision_interpret"
  | "call_lookup"
  | "text_prepare"
  | "llm";

/**
 * Returns a short, spoken-friendly progress cue for the given route.
 * Keeps Nova from going silent while she works.
 */
function getProgressCue(type: CueType): string {
  switch (type) {
    case "time":             return "Checking time.";
    case "battery":          return "Checking battery.";
    case "connection":       return "Checking connection.";
    case "uptime":           return "Checking session.";
    case "help":             return "Sure.";
    case "live_lookup":      return "Checking online.";
    case "vision_scene":     return "Looking now.";
    case "vision_ocr":       return "Reading it.";
    case "vision_interpret": return "Analyzing that.";
    case "call_lookup":      return "Looking up the number.";
    case "text_prepare":     return "Preparing the message.";
    case "llm":              return "On it.";
  }
}

function clampTtsText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= CFG.ttsMaxChars) return trimmed;
  return trimmed.slice(0, CFG.ttsMaxChars).trimEnd() + "…";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone transcript stream (SSE)
// ─────────────────────────────────────────────────────────────────────────────
type PhoneEventType =
  | "status"
  | "partial"
  | "final"
  | "assistant-partial"
  | "assistant-final"
  | "mode"
  | "error";

type PhoneEvent = {
  type: PhoneEventType;
  text: string;
  ts: number;
};

type DeviceStatePayload = {
  type: "device_state";
  batteryLevel: number | null;
  caseBatteryLevel: number | null;
  charging: boolean | null;
  caseCharging: boolean | null;
  wifiConnected: boolean;
  wifiSsid: string | null;
  deviceModel: string | null;
  connected: boolean;
  ts: number;
};

// Phone action SSE payload — sent when Nova is ready to execute a confirmed action.
type PhoneActionPayload = {
  type: "phone-action";
  action: "call" | "text";
  label: string;
  target?: string;
  phoneNumber?: string;
  recipient?: string;
  message?: string;
  ts: number;
};

// Per-session pending phone action state.
type PendingAction =
  | { kind: "call"; target: string; phoneNumber?: string }
  | { kind: "text"; recipient: string; message: string }
  | { kind: "text_compose"; recipient: string };

const sseClientsByUser = new Map<string, Set<Response>>();

// Keyed by sessionId — cleared on session end.
const pendingActionBySession = new Map<string, PendingAction>();

function writeSse(res: Response, event: PhoneEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeDeviceStateSse(res: Response, payload: DeviceStatePayload): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastToUser(userId: string, event: PhoneEvent): void {
  const clients = sseClientsByUser.get(userId);
  if (!clients || clients.size === 0) return;

  for (const res of clients) {
    try {
      writeSse(res, event);
    } catch {
      clients.delete(res);
    }
  }

  if (clients.size === 0) {
    sseClientsByUser.delete(userId);
  }
}

function broadcastDeviceState(userId: string, payload: DeviceStatePayload): void {
  const clients = sseClientsByUser.get(userId);
  if (!clients || clients.size === 0) return;

  for (const res of clients) {
    try {
      writeDeviceStateSse(res, payload);
    } catch {
      clients.delete(res);
    }
  }

  if (clients.size === 0) {
    sseClientsByUser.delete(userId);
  }
}

function broadcastPhoneAction(userId: string, payload: PhoneActionPayload): void {
  const clients = sseClientsByUser.get(userId);
  if (!clients || clients.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
  if (clients.size === 0) sseClientsByUser.delete(userId);
}

function addSseClient(userId: string, res: Response): void {
  let set = sseClientsByUser.get(userId);
  if (!set) {
    set = new Set<Response>();
    sseClientsByUser.set(userId, set);
  }
  set.add(res);
}

function removeSseClient(userId: string, res: Response): void {
  const set = sseClientsByUser.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sseClientsByUser.delete(userId);
}

function phoneEvent(type: PhoneEventType, text: string): PhoneEvent {
  return { type, text, ts: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Webview HTML
// ─────────────────────────────────────────────────────────────────────────────
function renderWebviewHtml(userId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1,viewport-fit=cover"
  />
  <title>Nova Live Transcript</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1020;
      --panel: #131a2b;
      --border: #24304b;
      --text: #eef3ff;
      --muted: #97a6c5;
      --user: #1e2b45;
      --assistant: #163327;
      --status: #2b233f;
      --error: #452020;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(180deg, #08101a, #0b1020 30%, #0b1020);
      color: var(--text);
      font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      padding: 16px;
    }
    .wrap {
      max-width: 900px;
      margin: 0 auto;
      display: grid;
      gap: 12px;
    }
    .header {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px 16px;
    }
    .title {
      font-size: 18px;
      font-weight: 700;
      margin: 0 0 6px;
    }
    .sub {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
    }
    .statusbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      font-size: 13px;
      color: var(--muted);
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #58708f;
      box-shadow: 0 0 0 3px rgba(124, 199, 255, 0.12);
    }
    .dot.live { background: #34d399; }
    .feed {
      display: grid;
      gap: 10px;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 12px 14px;
      background: var(--panel);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .card.user { background: var(--user); }
    .card.assistant { background: var(--assistant); }
    .card.status { background: var(--status); color: var(--muted); }
    .card.error { background: var(--error); }
    .meta {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .live {
      outline: 1px dashed rgba(124, 199, 255, 0.55);
    }
    .hint {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: rgba(255,255,255,0.06);
      padding: 1px 6px;
      border-radius: 6px;
    }
    .telemetry {
      display: grid;
      gap: 8px;
    }
    .telem-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .telem-grid {
      display: grid;
      grid-template-columns: 72px 1fr;
      gap: 4px 12px;
      font-size: 13px;
      align-items: center;
    }
    .telem-label { color: var(--muted); }
    .telem-val { color: var(--text); font-weight: 500; }
    .telem-val.online  { color: #34d399; }
    .telem-val.offline { color: #f87171; }
    .telem-val.charging { color: #fbbf24; }
    .card.action { background: #131d35; border-color: #2a4070; }
    .action-detail { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
    .action-btns { display: flex; gap: 10px; margin-top: 10px; }
    .action-btn {
      display: inline-block;
      padding: 9px 22px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      border: none;
      font-family: inherit;
      transition: background 0.15s;
    }
    .action-btn-primary { background: #2563eb; color: #fff; }
    .action-btn-primary:hover { background: #1d4ed8; }
    .action-btn[disabled], .action-btn.disabled { opacity: 0.4; pointer-events: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="title">Nova Live Transcript</div>
      <p class="sub">Signed in as ${escapeHtml(userId)}</p>
    </div>

    <div class="header statusbar">
      <div style="display:flex;align-items:center;gap:10px;">
        <span id="dot" class="dot"></span>
        <span id="conn">Connecting…</span>
      </div>
      <div id="clock">—</div>
    </div>

    <div class="header hint">
      Speak <code>${escapeHtml(CFG.wakeWord)}</code> by itself to arm, or say
      <code>${escapeHtml(CFG.wakeWord)}, status check</code> to trigger immediately.
      Transcript stays on this phone page. Replies are spoken through Mentra audio.
    </div>

    <div class="header telemetry" id="telemetry">
      <div class="telem-title">NovaOS Live</div>
      <div class="telem-grid">
        <span class="telem-label">Device</span>
        <span class="telem-val" id="t-device">—</span>
        <span class="telem-label">Battery</span>
        <span class="telem-val" id="t-battery">—</span>
        <span class="telem-label">Case</span>
        <span class="telem-val" id="t-case">—</span>
        <span class="telem-label">WiFi</span>
        <span class="telem-val" id="t-wifi">—</span>
        <span class="telem-label">Session</span>
        <span class="telem-val" id="t-session">—</span>
      </div>
    </div>

    <div id="feed" class="feed"></div>
  </div>

  <script>
    const feed = document.getElementById("feed");
    const conn = document.getElementById("conn");
    const dot = document.getElementById("dot");
    const clock = document.getElementById("clock");

    function time(ts) {
      return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    }

    function tickClock() {
      clock.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    }
    tickClock();
    setInterval(tickClock, 1000);

    function makeCard(kind, label, text, ts, live = false) {
      const card = document.createElement("div");
      card.className = "card " + kind + (live ? " live" : "");

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = label + " • " + time(ts);

      const body = document.createElement("div");
      body.textContent = text;

      card.appendChild(meta);
      card.appendChild(body);
      return card;
    }

    function updateTelemetryPanel(state) {
      const battEl    = document.getElementById("t-battery");
      const caseEl    = document.getElementById("t-case");
      const wifiEl    = document.getElementById("t-wifi");
      const deviceEl  = document.getElementById("t-device");
      const sessionEl = document.getElementById("t-session");

      // Battery
      if (state.batteryLevel !== null && state.batteryLevel !== undefined) {
        battEl.textContent = state.batteryLevel + "%"
          + (state.charging ? " ⚡" : "");
        battEl.className = "telem-val" + (state.charging ? " charging" : "");
      } else {
        battEl.textContent = "—";
        battEl.className = "telem-val";
      }

      // Case battery
      if (state.caseBatteryLevel !== null && state.caseBatteryLevel !== undefined) {
        caseEl.textContent = state.caseBatteryLevel + "%"
          + (state.caseCharging ? " ⚡" : "");
        caseEl.className = "telem-val" + (state.caseCharging ? " charging" : "");
      } else {
        caseEl.textContent = "—";
        caseEl.className = "telem-val";
      }

      // WiFi
      if (state.wifiConnected) {
        wifiEl.textContent = state.wifiSsid || "Connected";
        wifiEl.className = "telem-val online";
      } else {
        wifiEl.textContent = "Offline";
        wifiEl.className = "telem-val offline";
      }

      // Device model — strip underscores and title-case for readability
      deviceEl.textContent = state.deviceModel
        ? state.deviceModel.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
        : "—";

      // Session connection
      if (state.connected) {
        sessionEl.textContent = "Connected";
        sessionEl.className = "telem-val online";
      } else {
        sessionEl.textContent = "Offline";
        sessionEl.className = "telem-val offline";
      }
    }

    let livePartialEl = null;
    let liveAssistantEl = null;

    function prepend(el) {
      feed.prepend(el);
    }

    function upsertLivePartial(text, ts) {
      if (!livePartialEl) {
        livePartialEl = makeCard("user", "Listening", text, ts, true);
        prepend(livePartialEl);
        return;
      }
      livePartialEl.querySelector("div:last-child").textContent = text;
      livePartialEl.querySelector(".meta").textContent = "Listening • " + time(ts);
    }

    function finalizePartial(finalText, ts) {
      if (livePartialEl) {
        livePartialEl.remove();
        livePartialEl = null;
      }
      prepend(makeCard("user", "You", finalText, ts));
    }

    function upsertLiveAssistant(text, ts) {
      if (!liveAssistantEl) {
        liveAssistantEl = makeCard("assistant", "Nova (draft)", text, ts, true);
        prepend(liveAssistantEl);
        return;
      }
      liveAssistantEl.querySelector("div:last-child").textContent = text;
      liveAssistantEl.querySelector(".meta").textContent = "Nova (draft) • " + time(ts);
    }

    function finalizeAssistant(finalText, ts) {
      if (liveAssistantEl) {
        liveAssistantEl.remove();
        liveAssistantEl = null;
      }
      prepend(makeCard("assistant", "Nova", finalText, ts));
    }

    function renderPhoneActionCard(data) {
      const card = document.createElement("div");
      card.className = "card action";

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = "Action Ready \u2022 " + time(data.ts);
      card.appendChild(meta);

      const labelEl = document.createElement("div");
      labelEl.style.fontWeight = "600";
      labelEl.style.marginBottom = "6px";
      labelEl.textContent = data.label;
      card.appendChild(labelEl);

      if (data.phoneNumber) {
        const numEl = document.createElement("div");
        numEl.className = "action-detail";
        numEl.textContent = data.phoneNumber;
        card.appendChild(numEl);
      }

      if (data.message) {
        const msgEl = document.createElement("div");
        msgEl.className = "action-detail";
        msgEl.textContent = "\u201c" + data.message + "\u201d";
        card.appendChild(msgEl);
      }

      const btns = document.createElement("div");
      btns.className = "action-btns";

      if (data.action === "call") {
        const btn = document.createElement("a");
        if (data.phoneNumber) {
          btn.href = "tel:" + data.phoneNumber.replace(/\\D/g, "");
        } else {
          btn.className += " disabled";
        }
        btn.className = "action-btn action-btn-primary" + (data.phoneNumber ? "" : " disabled");
        btn.textContent = "Call";
        btns.appendChild(btn);
      } else if (data.action === "text") {
        const digits = data.phoneNumber ? data.phoneNumber.replace(/\\D/g, "") : "";
        const smsUri = digits
          ? "sms:" + digits + (data.message ? "?body=" + encodeURIComponent(data.message) : "")
          : "sms:?body=" + encodeURIComponent(data.message || "");
        const btn = document.createElement("a");
        btn.href = smsUri;
        btn.className = "action-btn action-btn-primary";
        btn.textContent = "Send";
        btns.appendChild(btn);
      }

      card.appendChild(btns);
      prepend(card);
    }

    const params = new URLSearchParams(window.location.search);
    const token = params.get("aos_frontend_token");
    const streamUrl = token
      ? "/api/transcripts?aos_frontend_token=" + encodeURIComponent(token)
      : "/api/transcripts";

    const es = new EventSource(streamUrl);

    es.onopen = () => {
      conn.textContent = "Live";
      dot.classList.add("live");
    };

    es.onerror = () => {
      conn.textContent = "Disconnected / retrying";
      dot.classList.remove("live");
    };

    es.onmessage = (evt) => {
      const data = JSON.parse(evt.data);

      if (data.type === "device_state") {
        updateTelemetryPanel(data);
        return;
      }

      if (data.type === "phone-action") {
        renderPhoneActionCard(data);
        return;
      }

      if (data.type === "partial") {
        upsertLivePartial(data.text, data.ts);
        return;
      }

      if (data.type === "final") {
        finalizePartial(data.text, data.ts);
        return;
      }

      if (data.type === "assistant-partial") {
        upsertLiveAssistant(data.text, data.ts);
        return;
      }

      if (data.type === "assistant-final") {
        finalizeAssistant(data.text, data.ts);
        return;
      }

      if (data.type === "mode") {
        prepend(makeCard("status", "Mode", data.text, data.ts));
        return;
      }

      if (data.type === "error") {
        prepend(makeCard("error", "Error", data.text, data.ts));
        return;
      }

      prepend(makeCard("status", "Status", data.text, data.ts));
    };
  </script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────
class NovaMentraApp extends AppServer {
  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      port: CFG.port,
    });

    this.registerWebRoutes();
  }

  private registerWebRoutes(): void {
    const app = this.getExpressApp();

    app.get("/healthz", (_req, res) => {
      res.status(200).json({ ok: true, app: PACKAGE_NAME, port: CFG.port });
    });

    app.get("/webview", (req: AuthenticatedRequest, res) => {
      const userId = req.authUserId;

      if (!userId) {
        res
          .status(401)
          .send(
            `<html><body style="font-family:sans-serif;padding:24px;">
              <h2>Nova Mentra</h2>
              <p>Please open this page from the Mentra app, or <a href="/mentra-auth">sign in with Mentra</a>.</p>
            </body></html>`
          );
        return;
      }

      res.status(200).send(renderWebviewHtml(userId));
    });

    app.get("/api/transcripts", (req: AuthenticatedRequest, res) => {
      const userId = req.authUserId;

      if (!userId) {
        res.status(401).end("Not authenticated");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      addSseClient(userId, res);
      writeSse(res, phoneEvent("status", "Phone transcript connected."));

      const keepAlive = setInterval(() => {
        res.write(": keep-alive\n\n");
      }, 20000);

      req.on("close", () => {
        clearInterval(keepAlive);
        removeSseClient(userId, res);
      });
    });
  }

  protected override async onSession(
    session: Session,
    _sessionId: string,
    userId: string
  ): Promise<void> {
    const sessionId = session.sessionId;

    // ── Voice profile (session-scoped) ───────────────────────────────────────
    let currentVoiceProfile: VoiceProfile = "default";
    /** Returns the ElevenLabs voice ID for the current profile, with fallback. */
    const getVoiceId = (): string | undefined =>
      VOICE_PROFILES[currentVoiceProfile] ?? VOICE_PROFILES.default;
    // ─────────────────────────────────────────────────────────────────────────

    console.log(`[${sessionId}] Session started for ${userId}`);
    broadcastToUser(
      userId,
      phoneEvent(
        "status",
        `Connected to ${session.capabilities?.modelName ?? "Mentra device"}.`
      )
    );

    if (CFG.speakBootGreeting) {
      try {
        await session.audio.speak("Nova online.", {
          model_id: CFG.ttsModel,
          voice_id: getVoiceId(),
        });
      } catch (err) {
        console.warn(`[${sessionId}] Boot greeting failed:`, err);
      }
    }

    session.events.onGlassesBattery((evt) => {
      console.log(`[${sessionId}] Battery: ${evt.level}%`);
      broadcastToUser(userId, phoneEvent("status", `Glasses battery ${evt.level}%`));
    });

    // ── Device state telemetry → SSE ─────────────────────────────────────
    const pushDeviceState = (): void => {
      const ds = session.device.state;
      broadcastDeviceState(userId, {
        type: "device_state",
        batteryLevel: ds.batteryLevel.value,
        caseBatteryLevel: ds.caseBatteryLevel.value,
        charging: ds.charging.value,
        caseCharging: ds.caseCharging.value,
        wifiConnected: ds.wifiConnected.value,
        wifiSsid: ds.wifiSsid.value,
        deviceModel: ds.modelName.value,
        connected: ds.connected.value,
        ts: Date.now(),
      });
    };

    // Push current snapshot immediately, then whenever any field changes.
    pushDeviceState();
    session.device.state.batteryLevel.onChange(() => pushDeviceState());
    session.device.state.caseBatteryLevel.onChange(() => pushDeviceState());
    session.device.state.charging.onChange(() => pushDeviceState());
    session.device.state.caseCharging.onChange(() => pushDeviceState());
    session.device.state.wifiConnected.onChange(() => pushDeviceState());
    session.device.state.wifiSsid.onChange(() => pushDeviceState());
    session.device.state.connected.onChange(() => pushDeviceState());
    session.device.state.modelName.onChange(() => pushDeviceState());
    // ─────────────────────────────────────────────────────────────────────

    const wakeTicker = setInterval(() => {
      const didDisarm = disarmIfExpired(sessionId);

      if (didDisarm) {
        broadcastToUser(userId, phoneEvent("status", "Wake timeout expired."));
      } else if (isWakeArmed(sessionId)) {
        const left = Math.ceil(getWakeArmRemainingMs(sessionId) / 1000);
        broadcastToUser(userId, phoneEvent("status", `Armed for ${left}s`));
      }
    }, 1000);

    const sessionStartMs = Date.now();
    let inFlight: AbortController | null = null;
    let lastAssistantPartialAt = 0;
    let fullReply = "";
    let ignoreTranscriptsUntil = 0;
    let followupUntil = 0;

    /**
     * Speaks a short cue phrase immediately, sets the echo-suppression window,
     * and swallows errors so a failed cue never blocks the real answer.
     */
    const speakCue = async (text: string): Promise<void> => {
      try {
        ignoreTranscriptsUntil = Date.now() + 4000;
        console.log(`[Nova] Cue: "${text}"`);
        await session.audio.speak(text, {
          model_id: CFG.ttsModel,
          voice_id: getVoiceId(),
        });
      } catch (err) {
        console.warn(`[${sessionId}] Cue TTS failed:`, err);
      }
    };

    session.events.onTranscription(async (data) => {
      const raw = (data.text ?? "").trim();
      if (!raw) return;

      // Echo suppression: drop transcripts that arrive during TTS playback.
      // Exception: "stop" always passes so the user can interrupt.
      if (Date.now() < ignoreTranscriptsUntil && !raw.toLowerCase().includes("stop")) {
        console.log("[Nova] Ignoring transcript during TTS:", raw);
        return;
      }

      console.log(`[${sessionId}] transcription`, {
        text: raw,
        isFinal: data.isFinal,
      });

      if (!data.isFinal) {
        broadcastToUser(userId, phoneEvent("partial", raw));
        return;
      }

      broadcastToUser(userId, phoneEvent("final", raw));

      if (raw.toLowerCase().includes("stop")) {
        session.audio.stopAudio();
        if (inFlight) {
          inFlight.abort();
          inFlight = null;
        }
        broadcastToUser(userId, phoneEvent("status", "Audio stopped."));
        return;
      }

      const newMode = parseModeCommand(raw);
      if (newMode !== null) {
        setMode(sessionId, newMode);
        const modeText = `Mode: ${newMode}`;
        console.log(`[${sessionId}] ${modeText}`);
        broadcastToUser(userId, phoneEvent("mode", modeText));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
          await session.audio.speak(modeText, {
            model_id: CFG.ttsModel,
            voice_id: getVoiceId(),
          });
        } catch (err) {
          console.warn(`[${sessionId}] Mode TTS failed:`, err);
        }
        return;
      }

      if (isBareWake(raw, CFG.wakeWord)) {
        console.log("[Nova] Wake word detected:", normalizeWakeText(raw));
        armWake(sessionId, CFG.wakeArmMs);
        broadcastToUser(userId, phoneEvent("status", "Armed. Waiting for next command."));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
          await session.audio.speak("Ready.", {
            model_id: CFG.ttsModel,
            voice_id: getVoiceId(),
          });
        } catch (err) {
          console.warn(`[${sessionId}] Wake TTS failed:`, err);
        }
        return;
      }

      const armed = consumeWakeArm(sessionId);
      const triggered = shouldTriggerNova(raw, CFG.wakeWord, armed);

      // Follow-up window: accept one unwaked utterance after each response.
      const inFollowup = !triggered && Date.now() < followupUntil;
      if (inFollowup) {
        console.log("[Nova] Follow-up accepted without wake word:", raw);
        followupUntil = 0; // single-use: consume immediately
      }

      console.log(`[${sessionId}] trigger check`, { raw, armed, triggered, inFollowup });
      if (!triggered && !inFollowup) return;

      const userText = stripWakePrefix(raw, CFG.wakeWord);
      if (!userText) return;

      const currentState = getSessionState(sessionId);
      if (currentState.mode === "SILENT") {
        broadcastToUser(userId, phoneEvent("status", "Silent mode active."));
        return;
      }

      // Open a follow-up window so the next reply doesn't need the wake word.
      followupUntil = Date.now() + 8000;
      console.log("[Nova] Follow-up window set until:", followupUntil);

      // ── Pending phone action: confirmation / compose / cancel ─────────────
      const pendingAction = pendingActionBySession.get(sessionId);
      if (pendingAction) {
        // text_compose: user is now providing the message body
        if (pendingAction.kind === "text_compose") {
          if (isCancellation(userText)) {
            pendingActionBySession.delete(sessionId);
            const cancelReply = "Cancelled.";
            pushTurn(sessionId, { role: "user", text: userText });
            pushTurn(sessionId, { role: "assistant", text: cancelReply });
            broadcastToUser(userId, phoneEvent("assistant-final", cancelReply));
            try {
              ignoreTranscriptsUntil = Date.now() + 4000;
              await session.audio.speak(cancelReply, { model_id: CFG.ttsModel, voice_id: getVoiceId() });
            } catch {}
            return;
          }
          // Treat utterance as the message
          const { recipient } = pendingAction;
          const composedMessage = userText;
          pendingActionBySession.set(sessionId, { kind: "text", recipient, message: composedMessage });
          const confirmMsg = `Ready to send: ${composedMessage}`;
          pushTurn(sessionId, { role: "user", text: userText });
          pushTurn(sessionId, { role: "assistant", text: confirmMsg });
          broadcastToUser(userId, phoneEvent("status", `Action pending: Text ${recipient}`));
          broadcastToUser(userId, phoneEvent("assistant-final", confirmMsg));
          try {
            ignoreTranscriptsUntil = Date.now() + 4000;
            const ttsResult = await session.audio.speak(clampTtsText(confirmMsg), {
              model_id: CFG.ttsModel,
              voice_id: getVoiceId(),
            });
            if (!ttsResult.success) {
              broadcastToUser(userId, phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`));
            }
          } catch (ttsErr) {
            console.warn(`[${sessionId}] Text compose TTS failed:`, ttsErr);
          }
          return;
        }

        // call / text pending: check for confirmation or cancellation
        if (isConfirmation(userText)) {
          const execMsg =
            pendingAction.kind === "call"
              ? `Calling ${pendingAction.target}.`
              : `Sending the message.`;
          // Broadcast the actionable phone-action event to the phone UI
          if (pendingAction.kind === "call") {
            broadcastPhoneAction(userId, {
              type: "phone-action",
              action: "call",
              label: `Call ${pendingAction.target}`,
              target: pendingAction.target,
              phoneNumber: pendingAction.phoneNumber,
              ts: Date.now(),
            });
          } else {
            broadcastPhoneAction(userId, {
              type: "phone-action",
              action: "text",
              label: `Text ${pendingAction.recipient}`,
              recipient: pendingAction.recipient,
              message: pendingAction.message,
              ts: Date.now(),
            });
          }
          pendingActionBySession.delete(sessionId);
          pushTurn(sessionId, { role: "user", text: userText });
          pushTurn(sessionId, { role: "assistant", text: execMsg });
          broadcastToUser(userId, phoneEvent("assistant-final", execMsg));
          try {
            ignoreTranscriptsUntil = Date.now() + 4000;
            await session.audio.speak(clampTtsText(execMsg), {
              model_id: CFG.ttsModel,
              voice_id: getVoiceId(),
            });
          } catch {}
          return;
        }

        if (isCancellation(userText)) {
          pendingActionBySession.delete(sessionId);
          const cancelReply = "Cancelled.";
          pushTurn(sessionId, { role: "user", text: userText });
          pushTurn(sessionId, { role: "assistant", text: cancelReply });
          broadcastToUser(userId, phoneEvent("assistant-final", cancelReply));
          try {
            ignoreTranscriptsUntil = Date.now() + 4000;
            await session.audio.speak(cancelReply, {
              model_id: CFG.ttsModel,
              voice_id: getVoiceId(),
            });
          } catch {}
          return;
        }

        // Not a confirmation or cancellation — clear the stale pending action and fall through.
        pendingActionBySession.delete(sessionId);
      }
      // ─────────────────────────────────────────────────────────────────────

      if (inFlight) {
        inFlight.abort();
        inFlight = null;
      }
      session.audio.stopAudio();

      // ── Time query shortcut — answered locally, no LLM call ──────────────
      if (isTimeQuery(userText)) {
        console.log("[Nova] Time query detected:", userText);
        const timeCue = getProgressCue("time");
        broadcastToUser(userId, phoneEvent("status", timeCue));
        await speakCue(timeCue);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = session as any;
        const timezone: string =
          s.settings?.mentraosSettings?.userTimezone ??
          s.mentraosSettings?.userTimezone ??
          "America/Denver";
        console.log("[Nova] Time request handled for timezone:", timezone);

        const timeStr = new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: timezone,
          timeZoneName: "short",
        }).format(new Date());

        const timeReply = `It's ${timeStr}.`;

        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: timeReply });
        broadcastToUser(userId, phoneEvent("assistant-final", timeReply));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
          const ttsResult = await session.audio.speak(clampTtsText(timeReply), {
            model_id: CFG.ttsModel,
            voice_id: getVoiceId(),
          });
          if (!ttsResult.success) {
            console.warn(
              `[${sessionId}] TTS playback failed: ${ttsResult.error ?? "unknown error"}`
            );
            broadcastToUser(
              userId,
              phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`)
            );
          }
        } catch (ttsErr) {
          console.warn(`[${sessionId}] Time query TTS failed:`, ttsErr);
        }
        return;
      }

      // ── Battery status reflex ─────────────────────────────────────────────
      if (isBatteryQuery(userText)) {
        console.log("[Nova] Battery status requested");
        const batteryCue = getProgressCue("battery");
        broadcastToUser(userId, phoneEvent("status", batteryCue));
        await speakCue(batteryCue);

        const ds = session.device.state;
        const glassLevel = ds.batteryLevel.value;
        const isCharging = ds.charging.value;
        const caseLevel = ds.caseBatteryLevel.value;

        let batteryReply: string;
        if (glassLevel !== null) {
          batteryReply = `Glasses battery is ${glassLevel} percent${isCharging ? " and charging" : ""}.`;
          if (caseLevel !== null) {
            batteryReply += ` Case battery is ${caseLevel} percent.`;
          }
        } else {
          batteryReply = "Glasses battery level is unavailable.";
        }

        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: batteryReply });
        broadcastToUser(userId, phoneEvent("assistant-final", batteryReply));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
          const ttsResult = await session.audio.speak(clampTtsText(batteryReply), {
            model_id: CFG.ttsModel,
            voice_id: getVoiceId(),
          });
          if (!ttsResult.success) {
            console.warn(`[${sessionId}] TTS playback failed: ${ttsResult.error ?? "unknown error"}`);
            broadcastToUser(userId, phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`));
          }
        } catch (ttsErr) {
          console.warn(`[${sessionId}] Battery TTS failed:`, ttsErr);
        }
        return;
      }

      // ── Connection status reflex ──────────────────────────────────────────
      if (isConnectionQuery(userText)) {
        console.log("[Nova] Connection status requested");
        const connCue = getProgressCue("connection");
        broadcastToUser(userId, phoneEvent("status", connCue));
        await speakCue(connCue);

        const ds = session.device.state;
        const wifiConnected = ds.wifiConnected.value;
        const ssid = ds.wifiSsid.value;

        const connReply = wifiConnected
          ? ssid
            ? `Glasses are connected to Wi-Fi network ${ssid}.`
            : "Glasses are connected to Wi-Fi."
          : "Glasses are currently offline.";

        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: connReply });
        broadcastToUser(userId, phoneEvent("assistant-final", connReply));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
          const ttsResult = await session.audio.speak(clampTtsText(connReply), {
            model_id: CFG.ttsModel,
            voice_id: getVoiceId(),
          });
          if (!ttsResult.success) {
            console.warn(`[${sessionId}] TTS playback failed: ${ttsResult.error ?? "unknown error"}`);
            broadcastToUser(userId, phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`));
          }
        } catch (ttsErr) {
          console.warn(`[${sessionId}] Connection TTS failed:`, ttsErr);
        }
        return;
      }

      // ── Session uptime reflex ─────────────────────────────────────────────
      if (isSessionQuery(userText)) {
        console.log("[Nova] Session status requested");
        const uptimeCue = getProgressCue("uptime");
        broadcastToUser(userId, phoneEvent("status", uptimeCue));
        await speakCue(uptimeCue);

        const elapsedMs = Date.now() - sessionStartMs;
        const minutes = Math.floor(elapsedMs / 60000);
        const seconds = Math.floor((elapsedMs % 60000) / 1000);
        const uptimeReply = minutes > 0
          ? `Session has been running for ${minutes} minute${minutes !== 1 ? "s" : ""}.`
          : `Session has been running for ${seconds} second${seconds !== 1 ? "s" : ""}.`;

        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: uptimeReply });
        broadcastToUser(userId, phoneEvent("assistant-final", uptimeReply));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
          const ttsResult = await session.audio.speak(clampTtsText(uptimeReply), {
            model_id: CFG.ttsModel,
            voice_id: getVoiceId(),
          });
          if (!ttsResult.success) {
            console.warn(`[${sessionId}] TTS playback failed: ${ttsResult.error ?? "unknown error"}`);
            broadcastToUser(userId, phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`));
          }
        } catch (ttsErr) {
          console.warn(`[${sessionId}] Uptime TTS failed:`, ttsErr);
        }
        return;
      }

      // ── Local help / capability answers ──────────────────────────────────
      if (isHelpQuery(userText)) {
        console.log("[Nova] Routed to local help");
        const helpCue = getProgressCue("help");
        broadcastToUser(userId, phoneEvent("status", helpCue));
        await speakCue(helpCue);

        const helpReply = answerHelpQuery(userText);

        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: helpReply });
        broadcastToUser(userId, phoneEvent("assistant-final", helpReply));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
          const ttsResult = await session.audio.speak(clampTtsText(helpReply), {
            model_id: CFG.ttsModel,
            voice_id: getVoiceId(),
          });
          if (!ttsResult.success) {
            console.warn(`[${sessionId}] TTS playback failed: ${ttsResult.error ?? "unknown error"}`);
            broadcastToUser(userId, phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`));
          }
        } catch (ttsErr) {
          console.warn(`[${sessionId}] Help TTS failed:`, ttsErr);
        }
        return;
      }

      // ── Voice profile switch ──────────────────────────────────────────────
      if (isVoiceCommand(userText)) {
        const newProfile = parseVoiceProfile(userText);
        if (newProfile) {
          currentVoiceProfile = newProfile;
          console.log("[Nova] Voice profile changed:", newProfile);

          const label = VOICE_LABELS[newProfile];
          const confirmText = `${label} voice active.`;

          broadcastToUser(userId, phoneEvent("status", `Voice: ${label}`));
          pushTurn(sessionId, { role: "user", text: userText });
          pushTurn(sessionId, { role: "assistant", text: confirmText });
          broadcastToUser(userId, phoneEvent("assistant-final", confirmText));

          try {
            ignoreTranscriptsUntil = Date.now() + 4000;
            console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
            console.log("[Nova] Speaking with voice:", newProfile);
            await session.audio.speak(clampTtsText(confirmText), {
              model_id: CFG.ttsModel,
              voice_id: getVoiceId(),
            });
          } catch (ttsErr) {
            console.warn(`[${sessionId}] Voice switch TTS failed:`, ttsErr);
          }
        }
        return;
      }

      // ── Call intent ───────────────────────────────────────────────────────
      if (isCallIntent(userText)) {
        console.log("[Nova] Call intent detected:", userText);
        const callTarget = parseCallTarget(userText);

        if (!callTarget) {
          const reply = "Who would you like to call?";
          pushTurn(sessionId, { role: "user", text: userText });
          pushTurn(sessionId, { role: "assistant", text: reply });
          broadcastToUser(userId, phoneEvent("assistant-final", reply));
          try {
            ignoreTranscriptsUntil = Date.now() + 4000;
            await session.audio.speak(reply, { model_id: CFG.ttsModel, voice_id: getVoiceId() });
          } catch {}
          return;
        }

        const callCue = getProgressCue("call_lookup");
        broadcastToUser(userId, phoneEvent("status", callCue));
        await speakCue(callCue);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const callSessionAny = session as any;
        const callTimezone: string | undefined =
          callSessionAny.settings?.mentraosSettings?.userTimezone ??
          callSessionAny.mentraosSettings?.userTimezone ??
          undefined;

        let callPhoneNumber: string | undefined;
        try {
          const callLookup = await doLiveLookup({
            userText: `phone number for ${callTarget}`,
            timezone: callTimezone,
          });
          const extracted = extractPhoneNumber(callLookup.answer);
          if (extracted) callPhoneNumber = extracted;
          console.log("[Nova] Call lookup result:", callLookup.answer, "| number:", callPhoneNumber ?? "(none)");
        } catch (lookupErr) {
          console.warn(`[${sessionId}] Call number lookup failed:`, lookupErr);
        }

        pendingActionBySession.set(sessionId, { kind: "call", target: callTarget, phoneNumber: callPhoneNumber });

        const callConfirmMsg = callPhoneNumber
          ? `I found a number for ${callTarget}. Ready to call?`
          : `I couldn't find a number for ${callTarget}. Still want to try calling?`;

        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: callConfirmMsg });
        broadcastToUser(userId, phoneEvent("status", `Action pending: Call ${callTarget}`));
        broadcastToUser(userId, phoneEvent("assistant-final", callConfirmMsg));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          const ttsResult = await session.audio.speak(clampTtsText(callConfirmMsg), {
            model_id: CFG.ttsModel,
            voice_id: getVoiceId(),
          });
          if (!ttsResult.success) {
            broadcastToUser(userId, phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`));
          }
        } catch (ttsErr) {
          console.warn(`[${sessionId}] Call intent TTS failed:`, ttsErr);
        }
        return;
      }

      // ── Text intent ───────────────────────────────────────────────────────
      if (isTextIntent(userText)) {
        console.log("[Nova] Text intent detected:", userText);
        const textRecipient = parseTextRecipient(userText);

        if (!textRecipient) {
          const reply = "Who would you like to text?";
          pushTurn(sessionId, { role: "user", text: userText });
          pushTurn(sessionId, { role: "assistant", text: reply });
          broadcastToUser(userId, phoneEvent("assistant-final", reply));
          try {
            ignoreTranscriptsUntil = Date.now() + 4000;
            await session.audio.speak(reply, { model_id: CFG.ttsModel, voice_id: getVoiceId() });
          } catch {}
          return;
        }

        const textMessage = parseTextMessage(userText, textRecipient);

        if (!textMessage) {
          // Ask user to provide the message body
          pendingActionBySession.set(sessionId, { kind: "text_compose", recipient: textRecipient });
          const reply = `What would you like to say to ${textRecipient}?`;
          pushTurn(sessionId, { role: "user", text: userText });
          pushTurn(sessionId, { role: "assistant", text: reply });
          broadcastToUser(userId, phoneEvent("assistant-final", reply));
          try {
            ignoreTranscriptsUntil = Date.now() + 4000;
            await session.audio.speak(clampTtsText(reply), { model_id: CFG.ttsModel, voice_id: getVoiceId() });
          } catch (ttsErr) {
            console.warn(`[${sessionId}] Text compose TTS failed:`, ttsErr);
          }
          return;
        }

        const textCue = getProgressCue("text_prepare");
        broadcastToUser(userId, phoneEvent("status", textCue));
        await speakCue(textCue);

        pendingActionBySession.set(sessionId, { kind: "text", recipient: textRecipient, message: textMessage });

        const textConfirmMsg = `Ready to send: ${textMessage}`;
        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: textConfirmMsg });
        broadcastToUser(userId, phoneEvent("status", `Action pending: Text ${textRecipient}`));
        broadcastToUser(userId, phoneEvent("assistant-final", textConfirmMsg));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          const ttsResult = await session.audio.speak(clampTtsText(textConfirmMsg), {
            model_id: CFG.ttsModel,
            voice_id: getVoiceId(),
          });
          if (!ttsResult.success) {
            broadcastToUser(userId, phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`));
          }
        } catch (ttsErr) {
          console.warn(`[${sessionId}] Text intent TTS failed:`, ttsErr);
        }
        return;
      }

      // ── Live lookup (web-backed factual queries) ──────────────────────────
      if (isLiveLookupQuery(userText)) {
        console.log("[Nova] Routed to live lookup");
        const lookupCue = getProgressCue("live_lookup");
        broadcastToUser(userId, phoneEvent("status", lookupCue));
        await speakCue(lookupCue);

        // Extract location context from session settings for proximity queries.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessionAny = session as any;
        const lookupTimezone: string | undefined =
          sessionAny.settings?.mentraosSettings?.userTimezone ??
          sessionAny.mentraosSettings?.userTimezone ??
          undefined;

        let lookupReply: string;
        try {
          const result = await doLiveLookup({
            userText,
            timezone: lookupTimezone,
          });

          lookupReply = result.answer || "I couldn't find an answer for that.";
          console.log("[Nova] Web lookup result:", lookupReply);

          if (result.sources.length > 0) {
            console.log(
              "[Nova] Web lookup sources:",
              result.sources.map((s) => `${s.title}: ${s.url}`).join(" | ")
            );
            // Mirror source titles to phone transcript only — never spoken aloud.
            const sourceNote = result.sources
              .slice(0, 2)
              .map((s) => s.title)
              .join(", ");
            broadcastToUser(userId, phoneEvent("status", `Sources: ${sourceNote}`));
          }
        } catch (lookupErr) {
          const lookupMsg = lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
          console.warn(`[${sessionId}] Live lookup failed:`, lookupMsg);
          broadcastToUser(userId, phoneEvent("error", `Lookup failed: ${lookupMsg}`));
          lookupReply = "I couldn't complete the web lookup.";
        }

        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: lookupReply });
        broadcastToUser(userId, phoneEvent("assistant-final", lookupReply));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
          console.log("[Nova] Speaking with voice:", currentVoiceProfile);
          const ttsResult = await session.audio.speak(clampTtsText(lookupReply), {
            model_id: CFG.ttsModel,
            voice_id: getVoiceId(),
          });
          if (!ttsResult.success) {
            console.warn(`[${sessionId}] TTS playback failed: ${ttsResult.error ?? "unknown error"}`);
            broadcastToUser(userId, phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`));
          }
        } catch (ttsErr) {
          console.warn(`[${sessionId}] Lookup TTS failed:`, ttsErr);
        }
        return;
      }

      // ── Vision / camera reflex ────────────────────────────────────────────
      if (isVisionQuery(userText) || isOcrQuery(userText) || isInterpretQuery(userText)) {
        // Determine which of the three vision sub-modes applies.
        // Priority: OCR > interpret > scene (interpret & OCR phrases are more specific).
        const visionMode: "scene" | "ocr" | "interpret" = isOcrQuery(userText)
          ? "ocr"
          : isInterpretQuery(userText)
          ? "interpret"
          : "scene";

        console.log("[Nova] Vision query detected:", userText, "| mode:", visionMode);
        if (visionMode === "ocr") console.log("[Nova] OCR query detected");
        if (visionMode === "interpret") console.log("[Nova] Interpret query detected");

        const visionCue = getProgressCue(
          visionMode === "ocr" ? "vision_ocr"
          : visionMode === "interpret" ? "vision_interpret"
          : "vision_scene"
        );
        broadcastToUser(userId, phoneEvent("status", visionCue));
        await speakCue(visionCue);

        // ── Step 1: capture (4 s timeout, one automatic retry) ───────────
        broadcastToUser(userId, phoneEvent("status", "Capturing image..."));
        console.log("[Nova] Starting camera capture");

        // One attempt: race the SDK promise against a 4-second timer.
        // A shorter timeout (vs the old 10 s) lets us retry sooner when the
        // camera pipeline is stalled waiting for a prior request to drain.
        const attemptCapture = (): Promise<PhotoData> => {
          const photoPromise = session.camera.requestPhoto({ size: "medium" });
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Camera timeout after 4s")), 4000)
          );
          return Promise.race([photoPromise, timeoutPromise]);
        };

        let photo: PhotoData | null = null;

        // ── Attempt 1 ────────────────────────────────────────────────────
        try {
          console.log("[Nova] Camera capture attempt 1");
          photo = await attemptCapture();
          console.log("[Nova] Camera capture succeeded");
          console.log(`[${sessionId}] Photo captured: ${photo.size} bytes, ${photo.mimeType}`);
        } catch (err1) {
          const msg1 = err1 instanceof Error ? err1.message : String(err1);
          console.warn(`[Nova] Camera capture failed, retrying... (${msg1})`);

          // ── Attempt 2 (one retry) ───────────────────────────────────────
          try {
            console.log("[Nova] Camera capture attempt 2");
            photo = await attemptCapture();
            console.log("[Nova] Camera capture succeeded");
            console.log(`[${sessionId}] Photo captured: ${photo.size} bytes, ${photo.mimeType}`);
          } catch (err2) {
            console.warn("[Nova] Camera capture failed after retry");
          }
        }

        // Both attempts failed — speak natural fallback and bail out.
        if (!photo) {
          const errReply = "I couldn't capture the image.";
          broadcastToUser(userId, phoneEvent("error", "Camera capture failed after retry."));
          pushTurn(sessionId, { role: "user", text: userText });
          pushTurn(sessionId, { role: "assistant", text: errReply });
          broadcastToUser(userId, phoneEvent("assistant-final", errReply));

          try {
            ignoreTranscriptsUntil = Date.now() + 4000;
            console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
            await session.audio.speak(clampTtsText(errReply), {
              model_id: CFG.ttsModel,
              voice_id: getVoiceId(),
            });
          } catch (ttsErr) {
            console.warn(`[${sessionId}] Vision error TTS failed:`, ttsErr);
          }
          return;
        }

        // ── Step 2: analyze ──────────────────────────────────────────────
        const statusLabel =
          visionMode === "ocr"
            ? "Reading text..."
            : visionMode === "interpret"
            ? "Interpreting..."
            : "Analyzing image...";
        broadcastToUser(userId, phoneEvent("status", statusLabel));

        try {
          const visionReply = await askNovaVision({
            openai,
            cfg: { model: CFG.visionModel, wakeWord: CFG.wakeWord },
            mode: currentState.mode,
            imageBuffer: photo.buffer,
            mimeType: photo.mimeType,
            visionMode,
          });

          let finalReply: string;
          if (!visionReply) {
            finalReply =
              visionMode === "ocr"
                ? "I couldn't see any readable text."
                : visionMode === "interpret"
                ? "I don't see anything important or clear enough to interpret."
                : "(no description returned)";
          } else {
            if (visionMode === "ocr") console.log("[Nova] OCR text extracted:", visionReply);
            if (visionMode === "interpret") console.log("[Nova] Interpretation result:", visionReply);
            finalReply = visionReply;
          }
          pushTurn(sessionId, { role: "user", text: userText });
          pushTurn(sessionId, { role: "assistant", text: finalReply });
          broadcastToUser(userId, phoneEvent("assistant-final", finalReply));

          try {
            ignoreTranscriptsUntil = Date.now() + 4000;
            console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
            const ttsResult = await session.audio.speak(clampTtsText(finalReply), {
              model_id: CFG.ttsModel,
              voice_id: getVoiceId(),
            });
            if (!ttsResult.success) {
              console.warn(`[${sessionId}] TTS playback failed: ${ttsResult.error ?? "unknown error"}`);
              broadcastToUser(userId, phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`));
            }
          } catch (ttsErr) {
            console.warn(`[${sessionId}] Vision TTS failed:`, ttsErr);
          }
        } catch (visionErr) {
          const visionMsg = visionErr instanceof Error ? visionErr.message : String(visionErr);
          console.error(`[${sessionId}] Vision analysis failed:`, visionMsg);

          const errReply = "I captured it, but analysis failed.";
          broadcastToUser(userId, phoneEvent("error", `Vision analysis failed: ${visionMsg}`));
          pushTurn(sessionId, { role: "user", text: userText });
          pushTurn(sessionId, { role: "assistant", text: errReply });
          broadcastToUser(userId, phoneEvent("assistant-final", errReply));

          try {
            ignoreTranscriptsUntil = Date.now() + 4000;
            console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
            await session.audio.speak(clampTtsText(errReply), {
              model_id: CFG.ttsModel,
              voice_id: getVoiceId(),
            });
          } catch (ttsErr) {
            console.warn(`[${sessionId}] Vision error TTS failed:`, ttsErr);
          }
        }
        return;
      }
      // ─────────────────────────────────────────────────────────────────────

      console.log("[Nova] Routed to LLM reasoning");
      const llmCue = getProgressCue("llm");
      broadcastToUser(userId, phoneEvent("status", llmCue));
      await speakCue(llmCue);

      inFlight = new AbortController();
      const signal = inFlight.signal;
      fullReply = "";
      lastAssistantPartialAt = 0;

      try {
        const reply = await askNovaStream({
          openai,
          cfg: { model: CFG.model, wakeWord: CFG.wakeWord },
          mode: currentState.mode,
          history: currentState.history,
          userText,
          signal,
          onDelta: (delta) => {
            fullReply += delta;

            const now = Date.now();
            if (now - lastAssistantPartialAt < CFG.streamUpdateMs) return;
            lastAssistantPartialAt = now;

            broadcastToUser(userId, phoneEvent("assistant-partial", fullReply));
          },
        });

        if (signal.aborted) return;

        const finalText = (reply || fullReply || "").trim() || "(no reply)";

        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: finalText });

        broadcastToUser(userId, phoneEvent("assistant-final", finalText));

        const ttsText = clampTtsText(finalText);
        ignoreTranscriptsUntil = Date.now() + 4000;
        console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
        const ttsResult = await session.audio.speak(ttsText, {
          model_id: CFG.ttsModel,
          voice_id: getVoiceId(),
        });

        if (!ttsResult.success) {
          console.warn(`[${sessionId}] TTS playback failed: ${ttsResult.error ?? "unknown error"}`);
          broadcastToUser(
            userId,
            phoneEvent("error", `TTS failed: ${ttsResult.error ?? "unknown error"}`)
          );
        }
      } catch (err: unknown) {
        if (signal.aborted) return;

        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${sessionId}] LLM error:`, msg);

        const isQuota =
          msg.includes("insufficient_quota") ||
          msg.toLowerCase().includes("exceeded") ||
          msg.toLowerCase().includes("quota");

        const errText = isQuota
          ? "OpenAI billing/quota problem."
          : `LLM error: ${msg}`;

        broadcastToUser(userId, phoneEvent("error", errText));

        try {
          ignoreTranscriptsUntil = Date.now() + 4000;
          console.log("[Nova] TTS ignore window set until:", ignoreTranscriptsUntil);
          await session.audio.speak(
            isQuota ? "Open A I billing or quota problem." : "I hit an error. Check the server logs.",
            {
              model_id: CFG.ttsModel,
              voice_id: getVoiceId(),
            }
          );
        } catch (ttsErr) {
          console.warn(`[${sessionId}] Error TTS failed:`, ttsErr);
        }
      } finally {
        inFlight = null;
      }
    });

    session.events.onSessionEnd?.(() => {
      clearInterval(wakeTicker);
      if (inFlight) inFlight.abort();
      pendingActionBySession.delete(sessionId);
      clearSession(sessionId);

      console.log(`[${sessionId}] Session ended.`);
      broadcastToUser(userId, phoneEvent("status", "Session ended."));
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
const app = new NovaMentraApp();

console.log(`Nova starting on port ${CFG.port}…`);
app.start().catch((e) => {
  console.error("App start failed:", e);
  process.exitCode = 1;
});