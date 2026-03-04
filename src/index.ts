// src/index.ts
import "dotenv/config";
import {
  AppServer,
  AppSession,
  ViewType,
  type GlassesBatteryUpdate,
  type TranscriptionData,
} from "@mentra/sdk";

import {
  createNovaClient,
  parseModeCommand,
  shouldTriggerNova,
  askNovaStream,
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

import { safeShowTextWall, formatForGlasses } from "./display.js";

// ─── Env helpers ──────────────────────────────────────────────────────────────
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

// ─── Required env ─────────────────────────────────────────────────────────────
const PACKAGE_NAME = requireEnv("PACKAGE_NAME");
const MENTRAOS_API_KEY = requireEnv("MENTRAOS_API_KEY");
const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");

// ─── Config ───────────────────────────────────────────────────────────────────
const CFG = {
  model: process.env["OPENAI_MODEL"] ?? "gpt-5",
  wakeWord: (process.env["WAKE_WORD"] ?? "nova").toLowerCase(),
  port: envInt("PORT", 3000),

  // UX timing
  thinkingMs: envInt("THINKING_MS", 1200),
  replyMs: envInt("REPLY_MS", 12000),

  // Streaming update cadence
  streamUpdateMs: envInt("STREAM_UPDATE_MS", 250),

  // Wake-arm TTL
  wakeArmMs: envInt("WAKE_ARM_MS", 8000),

  // HUD wrap
  maxLines: envInt("MAX_LINES", 7),
  maxCharsPerLine: envInt("MAX_CHARS_PER_LINE", 28),
} as const;

// ─── OpenAI client ────────────────────────────────────────────────────────────
const openai = createNovaClient(OPENAI_API_KEY);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripWakePrefix(text: string, wakeWord: string): string {
  const re = new RegExp(`^${escapeRegex(wakeWord)}[\\s,:!?.-]*`, "i");
  const stripped = text.replace(re, "").trim();
  return stripped.length > 0 ? stripped : text.trim();
}

function isBareWake(text: string, wakeWord: string): boolean {
  return text.trim().toLowerCase() === wakeWord.trim().toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function show(
  session: AppSession,
  text: string,
  durationMs: number,
  view: ViewType = ViewType.MAIN
): Promise<void> {
  await safeShowTextWall(session, text, { view, durationMs });
  // Brief dwell so rapid sequential calls don't instantly overwrite each other.
  await sleep(Math.min(durationMs, 500));
}

// ─── App ──────────────────────────────────────────────────────────────────────
class NovaMentraApp extends AppServer {
  protected override async onSession(
    session: AppSession,
    _sessionId: string,
    _userId: string
  ): Promise<void> {
    const sessionId = session.getSessionId();
    const state = getSessionState(sessionId);

    // Boot greeting
    await show(session, "NOVA online.", 1800);

    // Battery telemetry
    session.events.onGlassesBattery((evt: GlassesBatteryUpdate) => {
      console.log(`[${sessionId}] Battery: ${evt.level}%`);
    });

    // Wake-arm timeout ticker — shows countdown on HUD, auto-disarms on expiry
    const wakeTicker = setInterval(() => {
      void (async () => {
        const didDisarm = disarmIfExpired(sessionId);
        if (didDisarm) {
          await safeShowTextWall(session, "Disarmed", {
            view: ViewType.MAIN,
            durationMs: 900,
          });
        } else if (isWakeArmed(sessionId)) {
          const left = Math.ceil(getWakeArmRemainingMs(sessionId) / 1000);
          await safeShowTextWall(session, `Armed… ${left}s`, {
            view: ViewType.MAIN,
            durationMs: 650,
          });
        }
      })();
    }, 1000);

    // Concurrency: abort in-flight OpenAI stream when new final arrives
    let inFlight: AbortController | null = null;

    // Partial-transcript throttle timestamp
    let lastPartialUpdateAt = 0;

    // ── ONE transcription handler ─────────────────────────────────────────────
    session.events.onTranscription(async (data: TranscriptionData) => {
      const raw = (data.text ?? "").trim();
      if (!raw) return;

      // ── PARTIAL: live "Listening" text (throttled to 700 ms) ─────────────
      if (!data.isFinal) {
        const now = Date.now();
        if (now - lastPartialUpdateAt < 700) return;
        lastPartialUpdateAt = now;

        await safeShowTextWall(session, `Listening…\n${raw}`, {
          view: ViewType.MAIN,
          durationMs: 650,
        });
        return;
      }

      // ── FINAL ─────────────────────────────────────────────────────────────

      // Cancel any in-flight generation if user speaks again
      if (inFlight) {
        inFlight.abort();
        inFlight = null;
        await safeShowTextWall(session, "↺ New input", {
          view: ViewType.MAIN,
          durationMs: 700,
        });
      }

      // 1) Mode command?
      const newMode = parseModeCommand(raw);
      if (newMode !== null) {
        setMode(sessionId, newMode);
        await show(session, `Mode: ${newMode}`, 1400);
        return;
      }

      // 2) Bare wake word → arm for next utterance + HUD status
      if (isBareWake(raw, CFG.wakeWord)) {
        armWake(sessionId, CFG.wakeArmMs);
        await show(session, "Armed…", 900);
        return;
      }

      // 3) Wake gate (consumes armed flag if present)
      const armed = consumeWakeArm(sessionId);
      const triggered = shouldTriggerNova(raw, CFG.wakeWord, armed);
      if (!triggered) return;

      // 4) Clean user intent
      const userText = stripWakePrefix(raw, CFG.wakeWord);
      if (!userText) return;

      // 5) SILENT hardening: no API call
      if (state.mode === "SILENT") {
        await show(session, "Silent.", 900);
        return;
      }

      // 6) UX: Heard
      await show(session, `Heard:\n${userText}`, 1200);

      // 7) Streaming reply
      inFlight = new AbortController();
      const signal = inFlight.signal;

      await show(session, "Thinking…", CFG.thinkingMs);

      // Rolling buffer for incremental HUD display
      let fullReply = "";
      let lastRenderAt = 0;

      const renderPartial = async (text: string): Promise<void> => {
        const now = Date.now();
        if (now - lastRenderAt < CFG.streamUpdateMs) return;
        lastRenderAt = now;

        const tail = text.length > 600 ? text.slice(-600) : text;
        const hud = formatForGlasses(tail, CFG.maxLines, CFG.maxCharsPerLine);
        await safeShowTextWall(session, hud || "…", {
          view: ViewType.MAIN,
          durationMs: 900,
        });
      };

      try {
        const reply = await askNovaStream({
          openai,
          cfg: { model: CFG.model, wakeWord: CFG.wakeWord },
          mode: state.mode,
          history: state.history,
          userText,
          signal,
          onDelta: (delta) => {
            fullReply += delta;
            // fire-and-forget — don't block the stream loop
            void renderPartial(fullReply);
          },
        });

        if (signal.aborted) return;

        const finalText = (reply || fullReply || "").trim();

        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: finalText });

        const out = finalText
          ? formatForGlasses(finalText, CFG.maxLines, CFG.maxCharsPerLine)
          : "(no reply)";

        await safeShowTextWall(session, out, {
          view: ViewType.MAIN,
          durationMs: CFG.replyMs,
        });
      } catch (err: unknown) {
        if (signal.aborted) return;

        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${sessionId}] LLM error:`, msg);

        const isQuota =
          msg.includes("insufficient_quota") ||
          msg.toLowerCase().includes("exceeded") ||
          msg.toLowerCase().includes("quota");

        const errDisplay = isQuota
          ? "OpenAI: billing/quota.\nFix in platform."
          : "LLM error.\nCheck server logs.";

        await safeShowTextWall(session, errDisplay, {
          view: ViewType.MAIN,
          durationMs: 4500,
        });
      } finally {
        inFlight = null;
      }
    });

    // ── Cleanup on disconnect ─────────────────────────────────────────────────
    session.events.onDisconnected((_data) => {
      clearInterval(wakeTicker);
      if (inFlight) inFlight.abort();
      clearSession(sessionId);
      console.log(`[${sessionId}] Session disconnected.`);
    });
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const app = new NovaMentraApp({
  packageName: PACKAGE_NAME,
  apiKey: MENTRAOS_API_KEY,
  port: CFG.port,
});

console.log(`Nova starting on port ${CFG.port} …`);
app.start().catch((e: unknown) => {
  console.error("App start failed:", e);
  process.exitCode = 1;
});
