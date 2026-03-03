import type { NovaMode, Turn } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const HISTORY_MAX = 16;

// ─── Session State ────────────────────────────────────────────────────────────

interface SessionState {
  mode: NovaMode;
  history: Turn[];
  wakeArmed: boolean;
}

const sessions = new Map<string, SessionState>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultState(): SessionState {
  return { mode: "TACTICAL", history: [], wakeArmed: false };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns (and lazily creates) the session state for a given sessionId.
 */
export function getSessionState(sessionId: string): SessionState {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, defaultState());
  }
  return sessions.get(sessionId)!;
}

/**
 * Change the active NovaMode for a session.
 */
export function setMode(sessionId: string, mode: NovaMode): void {
  getSessionState(sessionId).mode = mode;
}

/**
 * Mark the wake-arm flag so the next utterance fires Nova regardless of
 * whether it starts with the wake word.
 */
export function armWake(sessionId: string): void {
  getSessionState(sessionId).wakeArmed = true;
}

/**
 * Read and clear the wake-arm flag.  Returns true if it was set.
 */
export function consumeWakeArm(sessionId: string): boolean {
  const state = getSessionState(sessionId);
  const was = state.wakeArmed;
  state.wakeArmed = false;
  return was;
}

/**
 * Append a turn to the ring buffer, evicting the oldest pair when full.
 */
export function pushTurn(sessionId: string, turn: Turn): void {
  const state = getSessionState(sessionId);
  state.history.push(turn);
  // Keep the buffer at most HISTORY_MAX entries.
  if (state.history.length > HISTORY_MAX) {
    state.history.splice(0, state.history.length - HISTORY_MAX);
  }
}

/**
 * Remove all state for a session (call on session close to free memory).
 */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}
