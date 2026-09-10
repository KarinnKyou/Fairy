# HDD v0.01 (demo)

A Fairy-themed desktop terminal: a full-screen window with a centred mascot that changes
state as the conversation progresses, and CMD-style terminal input/output below it.
Conversations are driven by the **DeepSeek API** (SSE streaming).

This is the **first public demo**, showing the look and interaction. It is not feature
complete.

---

## Quick start (using the prebuilt exe)

Download the attachment **`HDD-0.01.exe`** (96.6 MB, single portable file, no install,
Windows x64).

> **This exe contains no API key.** You must configure one as described in step 2, or the
> app cannot hold a conversation.

### 1. Run it

Double-click `HDD-0.01.exe`. SmartScreen may block it on first launch (unsigned local
build) — choose "More info → Run anyway".

- **Esc** quits
- Type in the input row at the bottom and press **Enter** to send

### 2. Configure your API key (required)

A portable exe does **not** read a `config.json` sitting next to it (it unpacks itself
into `%TEMP%` on every launch). Use an environment variable instead:

```powershell
setx DEEPSEEK_API_KEY "sk-your-deepseek-api-key"
```

Then **restart the app** — already-running processes do not see the new variable. To use
a different model:

```powershell
setx DEEPSEEK_MODEL "deepseek-v4-flash"
```

Get an API key at https://platform.deepseek.com.

### 3. Font (optional, but strongly recommended)

**This repository contains no font files** (licensing). Without one the app still runs and
falls back to the system font `Microsoft YaHei`, losing the intended look.

To restore the original appearance, obtain a CJK font of your own, place it in
`app/fonts/` and rebuild; `scripts/prep.cjs` reads its family name and weight
automatically with **no configuration changes needed**.

---

## Running from source

```sh
git clone https://github.com/KarinnKyou/Fairy.git
cd Fairy/app
npm install
copy config.example.json config.json   # fill in your apiKey
npm start
```

To package:

```sh
npm run dist     # -> app/dist/
```

---

## Current status and known limitations

- **Windows x64 only**, single portable file
- Conversation history keeps the most recent 30 messages; context is not persisted
  between sessions
- The window is always full-screen; there is no windowed mode. Esc quits
- No cancel button for streaming (a reply in progress cannot be interrupted)
- Only one font weight is supported: make sure the font's weight matches
  `--fairy-weight`, otherwise the browser synthesizes a bold and CJK text blurs

## Roadmap

`v0.1` → `v0.2` → ... → `v1.0`, iterating gradually. The current build is a
form-verification demo.

## License and notices

- Apache License 2.0, © 2026 Chengzhibense (see `LICENSE` / `NOTICE` /
  `THIRD_PARTY_NOTICES.md`)
- Visual assets originate from **Fairy-DSH-main** (the `dsh-fairy-visual` plugin); this
  project reuses only its visuals and engineering practices, not its runtime
- **This repository contains no font files, official assets, game text or private corpora**
- The names "Fairy" and "DeepSeek" are used for role-play within this project only and
  imply no official affiliation with any related party
- This demo exe **contains no API key**; supply your own. Never package someone else's key
  into a build you distribute
