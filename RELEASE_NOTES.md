# HDD v0.1

A Fairy-themed desktop terminal: a full-screen window with a centred mascot that changes
state as the conversation progresses, and CMD-style terminal input/output below it.
Conversations are driven by the **DeepSeek API** (SSE streaming).

This is the **first release with memory**. v0.01 showed the look; v0.1 remembers what was
said. It is still far from feature complete — see the roadmap below.

---

## Quick start (using the prebuilt exe)

Download the attachment **`HDD-0.1.0.exe`** (single portable file, no install, Windows x64).

> **This exe contains no API key.** You must configure one as described in step 2, or the
> app cannot hold a conversation.

### 1. Run it

Double-click `HDD-0.1.0.exe`. SmartScreen may block it on first launch (unsigned local
build) — choose "More info → Run anyway".

- **Esc** quits
- Type in the input row at the bottom and press **Enter** to send
- Your conversation is saved, and reappears when you open the app again

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

### 3. Font

**This exe contains no font, and neither does the repository** (licensing). It renders in
the system sans-serif (`Microsoft YaHei` / `Segoe UI`), which is readable but not the
intended look — the 0.01 demo embedded a font it should not have been redistributing.

To build with your own font, obtain a CJK font, place it in `app/fonts/` and run
`npm run dist`; `scripts/prep.cjs` reads its family name and weight automatically with **no
configuration changes needed**. Builds made by `release.ps1` deliberately exclude it.

---

## What is new since v0.01

- **Conversations persist.** They are stored in SQLite and redrawn when you reopen the app.
  Data location: `%APPDATA%\hdd\data\hdd.db` for the packaged exe, `app/data/hdd.db` when
  running from source.
- **Context is assembled per turn** from that store: system prompt, then what she knows
  about you (turns spoken, first meeting), then the most recent 32 messages.
- **Fixed a serious bug**: the message you had just typed was never sent to the model, so
  replies answered the *previous* question. If v0.01 felt like it was ignoring you, that
  was why.
- **Replies are a single line.** A model writing a blank line used to produce an empty line
  in the terminal; newlines now collapse to a space.
- **The persona is deliberately minimal** (~500 characters: who she is, what she cannot do,
  how she speaks). The full character returns at v1.0, once the capabilities it describes
  actually exist.
- **Nothing she claims is beyond her:** no camera, no hardware access, no tool calling, and
  she is instructed to say so rather than invent a result.

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
npm run dist     # -> app/dist/HDD-<version>.exe
```

Requires Node 22.5 or newer (24.x recommended) — the data layer uses the built-in
`node:sqlite`.

```sh
npm test                    # asset bake + all four test suites
npm run dev                 # run with a scratch data directory, so real history stays clean
npm run inspect             # print the transcript and what was sent to the model
```

---

## Known limitations

- **Windows x64 only**, single portable file
- **The exe renders in the system font** (see step 3) — this is the one way v0.1 looks
  worse than v0.01
- The window is always full-screen; there is no windowed mode. Esc quits
- No cancel button for streaming (a reply in progress cannot be interrupted)
- One implicit conversation: there are no topics or conversation switching yet (v0.2)
- Full-text search is indexed but has no interface yet (v0.2)
- Only one font weight is supported in a local build: the font's weight must match
  `--fairy-weight`, otherwise the browser synthesizes a bold and CJK text blurs

## Roadmap

`v0.1` → `v0.2` → ... → `v1.0`, iterating gradually. Each release is a working build; the
nine phases and the reasoning behind them are recorded in `docs/ADR.md`.

## License and notices

- Apache License 2.0, © 2026 Chengzhibense (see `LICENSE` / `NOTICE`)
- The released exe bundles **Electron** (MIT, © Electron contributors) and Chromium; their
  notices (`LICENSE.electron.txt`, `LICENSES.chromium.html`) ship beside the executable and
  must not be removed. See `THIRD_PARTY_NOTICES.md`
- Visual assets originate from **Fairy-DSH-main** (the `dsh-fairy-visual` plugin); this
  project reuses only its visuals and engineering practices, not its runtime
- **This repository contains no font files, official assets, game text or private corpora**
- The names "Fairy", "DSH" and "DeepSeek" are used for role-play and description only and
  imply no official affiliation with any related party
- This exe **contains no API key**; supply your own. Never package someone else's key into a
  build you distribute
