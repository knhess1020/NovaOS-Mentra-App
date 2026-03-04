// src/memory.ts
import type { NovaMode, Turn } from "./types.js";

const HISTORY_MAX = 16;

interface SessionState {
  mode: NovaMode;
  history: Turn[];
  wakeArmed: boolean;
  wakeArmExpiresAt: number; // epoch ms, 0 if not armed
}

const sessions = new Map<string, SessionState>();

function defaultState(): SessionState {
  return {
    mode: "TACTICAL",
    history: [],
    wakeArmed: false,
    wakeArmExpiresAt: 0,
  };
}

export function getSessionState(sessionId: string): SessionState {
  if (!sessions.has(sessionId)) sessions.set(sessionId, defaultState());
  return sessions.get(sessionId)!;
}

export function setMode(sessionId: string, mode: NovaMode): void {
  getSessionState(sessionId).mode = mode;
}

export function pushTurn(sessionId: string, turn: Turn): void {
  const state = getSessionState(sessionId);
  state.history.push(turn);
  if (state.history.length > HISTORY_MAX) {
    state.history.splice(0, state.history.length - HISTORY_MAX);
  }
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Arms wake for ttlMs. Next utterance will trigger Nova even without wake word.
 */
export function armWake(sessionId: string, ttlMs = 8000): void {
  const state = getSessionState(sessionId);
  state.wakeArmed = true;
  state.wakeArmExpiresAt = Date.now() + ttlMs;
}

/**
 * Read+clear wake arm flag. Returns true if armed AND not expired.
 */
export function consumeWakeArm(sessionId: string): boolean {
  const state = getSessionState(sessionId);
  const now = Date.now();
  const armedAndValid = state.wakeArmed && state.wakeArmExpiresAt > now;

  state.wakeArmed = false;
  state.wakeArmExpiresAt = 0;

  return armedAndValid;
}

/**
 * Non-destructive check: is wake armed right now (and not expired)?
 */
export function isWakeArmed(sessionId: string): boolean {
  const state = getSessionState(sessionId);
  return state.wakeArmed && state.wakeArmExpiresAt > Date.now();
}

export function getWakeArmRemainingMs(sessionId: string): number {
  const state = getSessionState(sessionId);
  if (!state.wakeArmed) return 0;
  return Math.max(0, state.wakeArmExpiresAt - Date.now());
}

/**
 * If expired, auto-disarm. Returns true if it just disarmed.
 */
export function disarmIfExpired(sessionId: string): boolean {
  const state = getSessionState(sessionId);
  if (!state.wakeArmed) return false;
  if (state.wakeArmExpiresAt <= Date.now()) {
    state.wakeArmed = false;
    state.wakeArmExpiresAt = 0;
    return true;
  }
  return false;
}
