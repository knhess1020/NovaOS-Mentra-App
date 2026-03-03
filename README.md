# NovaOS Mentra App

Nova is a smart-glasses AI assistant built on the Mentra SDK and OpenAI.
It listens for a wake word, renders concise replies on the glasses display,
and supports four operating modes: **TACTICAL**, **BUILD**, **SCAN**, **SILENT**.

---

## Requirements

| Tool | Minimum version |
|------|----------------|
| [Bun](https://bun.sh) | 1.1+ |
| Node types (via Bun) | — |
| Mentra glasses + app server | — |

---

## Setup

### 1. Clone / enter the project

```powershell
cd NovaOS-Mentra-App
```

### 2. Copy the env template and fill in your keys

```powershell
Copy-Item .env.example .env
notepad .env
```

Required values:

| Variable | Purpose |
|----------|---------|
| `PACKAGE_NAME` | Your Mentra app package name (e.g. `ai.valaria.forge`) |
| `MENTRAOS_API_KEY` | API key from the MentraOS developer portal |
| `OPENAI_API_KEY` | OpenAI secret key |

Optional tuning:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENAI_MODEL` | `gpt-5` | Model used for responses |
| `WAKE_WORD` | `nova` | Trigger word (case-insensitive) |
| `THINKING_MS` | `2500` | How long "Thinking…" stays on screen |
| `REPLY_MS` | `12000` | How long the reply stays on screen |
| `MAX_LINES` | `7` | Max lines rendered on the glasses |
| `MAX_CHARS_PER_LINE` | `28` | Max characters per line |
| `PORT` | `3000` | HTTP port for the app server |

### 3. Install dependencies

```powershell
bun install
```

### 4. Run in development mode (hot-reload)

```powershell
bun run dev
```

### 5. Run in production mode

```powershell
bun run start
```

---

## Wake word behaviour

Nova responds to speech that:

1. **Starts with the wake word** — `"Nova, what time is it?"` → triggers
2. **Is exactly the wake word** — `"Nova"` → arms the next utterance
3. **Wake-armed** — the utterance immediately after a bare wake word triggers Nova even without repeating the word

All other speech is ignored to avoid burning API tokens on ambient conversation.

### Mode commands

Speak any of the following to switch modes:

| Utterance | Mode |
|-----------|------|
| `"Mode tactical"` | TACTICAL (default) — fast, mission-critical |
| `"Mode build"` | BUILD — technical, tool-focused |
| `"Mode scan"` | SCAN — analytical, fact-first |
| `"Mode silent"` | SILENT — Nova goes dark |

---

## Display tuning

The glasses render text as a plain text wall.
Adjust `MAX_LINES` and `MAX_CHARS_PER_LINE` in `.env` to match your hardware.
The word-wrapper in `src/display.ts` (`formatForGlasses`) respects both limits.

---

## Project structure

```
NovaOS-Mentra-App/
  src/
    index.ts      — App entry: session handling, transcription pipeline
    nova.ts       — OpenAI client, wake gating, mode instructions, askNova()
    memory.ts     — Per-session state: mode, history ring buffer, wake arm flag
    display.ts    — Word-wrap + retry-safe showTextWall()
    types.ts      — NovaMode union, Turn interface
  .env.example    — Env template (safe to commit)
  .gitignore
  package.json
  tsconfig.json
  README.md
```

---

## Security

- **Never commit `.env`** — it is listed in `.gitignore`.
- Rotate your `OPENAI_API_KEY` and `MENTRAOS_API_KEY` if they are ever exposed.
