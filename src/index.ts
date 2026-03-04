import "dotenv/config";
import { AppServer, AppSession, type GlassesBatteryUpdate, type TranscriptionData } from "@mentra/sdk";
import {
  createNovaClient,
  parseModeCommand,
  shouldTriggerNova,
  askNova,
} from "./nova.js";
import {
  getSessionState,
  setMode,
  consumeWakeArm,
  pushTurn,
  clearSession,
} from "./memory.js";
import { safeShowTextWall, formatForGlasses } from "./display.js";
import type { NovaMode } from "./types.js";

// ─── Env validation ───────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return isNaN(n) ? fallback : n;
}

const PACKAGE_NAME = requireEnv("PACKAGE_NAME");
const MENTRAOS_API_KEY = requireEnv("MENTRAOS_API_KEY");
const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");

const CFG = {
  model: process.env["OPENAI_MODEL"] ?? "gpt-5",
  wakeWord: (process.env["WAKE_WORD"] ?? "nova").toLowerCase(),
  port: envInt("PORT", 3000),
  thinkingMs: envInt("THINKING_MS", 2500),
  replyMs: envInt("REPLY_MS", 12000),
  maxLines: envInt("MAX_LINES", 7),
  maxCharsPerLine: envInt("MAX_CHARS_PER_LINE", 28),
} as const;

// ─── OpenAI client ────────────────────────────────────────────────────────────

const openai = createNovaClient(OPENAI_API_KEY);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function show(
  session: AppSession,
  text: string,
  durationMs: number
): Promise<void> {
  await safeShowTextWall(session, text, { durationMs });
  await sleep(durationMs);
}

// Strip the wake word + optional punctuation/space from the front of an utterance.
function stripWakePrefix(text: string, wakeWord: string): string {
  const re = new RegExp(
    `^${wakeWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,!?.]*`,
    "i"
  );
  const stripped = text.replace(re, "").trim();
  return stripped.length > 0 ? stripped : text;
}

// ─── App ──────────────────────────────────────────────────────────────────────

class NovaMentraApp extends AppServer {
  protected override async onSession(
    session: AppSession,
    _sessionId: string,
    _userId: string
  ): Promise<void> {
    const sessionId = session.getSessionId();

    // Boot greeting
    await show(session, "NOVA online.", 2000);

    // Battery telemetry
    session.events.onGlassesBattery((evt: GlassesBatteryUpdate) => {
      console.log(`[${sessionId}] Battery: ${evt.level}%`);
    });

    // ── ONE transcription handler ─────────────────────────────────────────────
    let lastPartialUpdateAt = 0;

    session.events.onTranscription(async (data: TranscriptionData) => {
      const raw = data.text.trim();
      if (!raw) return;

      // ── Partial transcript ──────────────────────────────────────────────────
      if (!data.isFinal) {
        const now = Date.now();
        if (now - lastPartialUpdateAt < 800) return; // throttle to ≤ 1 update / 800 ms
        lastPartialUpdateAt = now;
        await safeShowTextWall(session, `🎤 ${raw}`, { durationMs: 900 });
        return;
      }

      // ── Final transcript ────────────────────────────────────────────────────

      // 1. Mode command?
      const newMode = parseModeCommand(raw);
      if (newMode !== null) {
        setMode(sessionId, newMode as NovaMode);
        await show(session, `Mode: ${newMode}`, 1800);
        return;
      }

      // 2. Wake-word gate
      const state = getSessionState(sessionId);
      const armed = consumeWakeArm(sessionId);
      if (!shouldTriggerNova(raw, CFG.wakeWord, armed)) return;

      // 3. Strip wake prefix to get clean user intent
      const userText = stripWakePrefix(raw, CFG.wakeWord);

      // 4. UX: Heard → Thinking → Reply
      await show(session, `Heard:\n${userText}`, 1400);
      await show(session, "Thinking…", CFG.thinkingMs);

      try {
        const reply = await askNova({
          openai,
          cfg: { model: CFG.model, wakeWord: CFG.wakeWord },
          mode: state.mode,
          history: state.history,
          userText,
        });

        // Persist turns
        pushTurn(sessionId, { role: "user", text: userText });
        pushTurn(sessionId, { role: "assistant", text: reply });

        const formatted = reply
          ? formatForGlasses(reply, CFG.maxLines, CFG.maxCharsPerLine)
          : "(no reply)";

        await show(session, formatted, CFG.replyMs);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${sessionId}] LLM error:`, msg);

        const isQuota =
          msg.includes("insufficient_quota") ||
          msg.toLowerCase().includes("exceeded") ||
          msg.toLowerCase().includes("quota");

        const errDisplay = isQuota
          ? "OpenAI: billing/quota.\nFix in platform."
          : "LLM error.\nCheck server logs.";

        await show(session, errDisplay, CFG.replyMs);
      }
    });

    // Cleanup on session disconnect
    session.events.onDisconnected(() => {
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
app.start();
