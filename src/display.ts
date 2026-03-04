// ─── Types ────────────────────────────────────────────────────────────────────
import { ViewType } from "@mentra/sdk";

// Minimal structural interface matching @mentra/sdk LayoutManager.
// showTextWall returns void (synchronous fire-and-forget in the SDK).
interface DisplaySession {
  layouts: {
    showTextWall(
      text: string,
      opts?: { view?: ViewType; durationMs?: number }
    ): void;
  };
}

// ─── Word-wrap ────────────────────────────────────────────────────────────────

/**
 * Wraps `text` to `maxCharsPerLine` columns, returning at most `maxLines`
 * lines joined by `\n`.  Pure word-wrap – no truncation mid-word.
 */
export function formatForGlasses(
  text: string,
  maxLines: number,
  maxCharsPerLine: number
): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (lines.length >= maxLines) break;

    const candidate = current.length === 0 ? word : `${current} ${word}`;

    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current.length > 0) {
        lines.push(current);
        current = "";
        if (lines.length >= maxLines) break;
      }
      // Word itself is longer than the line – hard-cut it.
      if (word.length > maxCharsPerLine) {
        lines.push(word.slice(0, maxCharsPerLine));
        current = word.slice(maxCharsPerLine);
      } else {
        current = word;
      }
    }
  }

  if (current.length > 0 && lines.length < maxLines) {
    lines.push(current);
  }

  return lines.join("\n");
}

// ─── Safe display with retry ──────────────────────────────────────────────────

const WS_NOT_READY = "WebSocket connection not established";

/**
 * Show a text wall on the glasses, retrying when the WebSocket isn't ready yet.
 */
export async function safeShowTextWall(
  session: DisplaySession,
  text: string,
  opts: { view?: ViewType; durationMs?: number } = {},
  tries = 12,
  delayMs = 250
): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      await session.layouts.showTextWall(text, opts);
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(WS_NOT_READY) && attempt < tries - 1) {
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
