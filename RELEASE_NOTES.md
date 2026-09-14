# HDD v0.2

A Fairy-themed desktop terminal: a full-screen window with a centred mascot that changes state as
the conversation progresses, and CMD-style terminal input/output below it. Conversations are
driven by the **DeepSeek API** (SSE streaming).

This release gives the conversation **structure**. Until now it was one undifferentiated
transcript; v0.2 splits it into topics as you talk, lets you switch between them, and gives you a
way to search everything ever said. Switching topics changes what she is reminded of — not just
what is on the screen.

---

## Quick start (using the prebuilt exe)

Download the attachment **`HDD-0.2.0.exe`** (single portable file, no install, Windows x64).

> **This exe contains no API key.** You must configure one as described in step 2, or the app
> cannot hold a conversation.

### 1. Run it

Double-click `HDD-0.2.0.exe`. SmartScreen may block it on first launch (unsigned local build) —
choose "More info → Run anyway".

- **Esc** quits
- Type in the input row at the bottom and press **Enter** to send
- Your conversation is saved, and reappears when you open the app again
- Type `/help` for the commands below

### 2. Configure your API key (required)

A portable exe does **not** read a `config.json` sitting next to it (it unpacks itself into
`%TEMP%` on every launch). Use an environment variable instead:

```powershell
setx DEEPSEEK_API_KEY "sk-your-deepseek-api-key"
```

Then **restart the app** — already-running processes do not see the new variable. To use a
different model:

```powershell
setx DEEPSEEK_MODEL "deepseek-v4-flash"
```

Get an API key at https://platform.deepseek.com.

### 3. Font

**This exe contains no font, and neither does the repository** (licensing). It renders in the
system sans-serif (`Microsoft YaHei` / `Segoe UI`), which is readable but not the intended look.

To build with your own font, obtain a CJK font, place it in `app/fonts/` and run `npm run dist`;
`scripts/prep.cjs` reads its family name and weight automatically with **no configuration changes
needed**. Builds made by `release.ps1` deliberately exclude it.

---

## What is new since v0.1

### Topics

- **Your conversation is split into subjects as it happens.** The names are generated — you will
  see things like 「终端项目」 or 「科幻电影推荐」 rather than a slice of your own sentence.
- **Six commands**, typed on the same input line. Anything starting with `/` is a command for the
  app and is never sent to the model:

  | Command | What it does |
  | --- | --- |
  | `/topics` | Every topic, newest activity first, with message counts; `*` marks the current one |
  | `/switch <序号\|id>` | Switch to a topic and repaint the transcript from it |
  | `/new [标题]` | Start a new topic (and switch to it) |
  | `/rename <标题>` | Rename the current topic |
  | `/search <关键词>` | Search every topic, showing where each hit came from |
  | `/help` | The list |

- **Switching changes what she is reminded of.** The history sent to the model is the current
  topic's history. The profile facts (first meeting, turns spoken) stay global, because they are
  about the relationship rather than a subject.
- **Search, finally reachable.** The full-text index has existed since v0.1 with no way to use it;
  `/search` reads it across every topic and shows the topic each hit came from. Chinese works,
  including two-character words.

### How the boundaries are decided, and what it costs

A new boundary is never guessed. A cheap local rule watches for a message that shares almost no
vocabulary with the current subject, and only then is the model asked one small question — same
subject, or a new one? **Only an explicit "yes" opens a topic.** If that request fails, times out,
or there is no API key, the message stays where it is: with no key configured, the app simply uses
one topic per sitting.

The honest cost: on turns that look like a change of subject, that is **one extra small request**,
and the reply waits for it. On one real 15-turn conversation it happened on 10 turns.

### Why it works this way

v0.1 never had topics, so the first attempt was built and tested against invented conversations.
The first real one disproved it: a local rule acting on its own split a single project into three
topics, and — worse than untidy — it made her answer the wrong question. Asked how *her project*
handled Chinese tokenization, with no history attached, she answered about her own tokenizer
instead. Being handed no context does not just lose information; it reinterprets what you said.

Both that failure and the fix are recorded with measurements in `docs/ADR.md` (ADR-012), and the
transcript itself is kept — with a judgement on every turn — in `docs/eval/`, where the tests
replay it. It is kept because two rounds of confident reasoning produced two wrong sets of
thresholds, and both times only a real conversation found it.

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

Requires Node 22.5 or newer (24.x recommended) — the data layer uses the built-in `node:sqlite`.

`app/` and the repository root each have their own `package.json`, and they do not offer the same
scripts: `dev`, `inspect`, `start` and `dist` live in `app/`; `test`, `assets:bake` and the
`app:*` wrappers live in the root. Running the wrong one fails with "missing script". The full
list is in `docs/COMMANDS.md`.

---

## Known limitations

- **Windows x64 only**, single portable file
- **The exe renders in the system font** — the one deliberate way a build looks worse than the
  0.0.1 demo, which embedded a font it should not have been redistributing
- The window is always full-screen; there is no windowed mode. Esc quits
- No cancel button for streaming (a reply in progress cannot be interrupted)
- **A topic boundary can cost one extra request**, and the reply waits for that request
- **Topic boundaries and names come from the model**, and the local thresholds behind them are
  still estimates: they have been corrected twice by real conversations, and three transcripts
  are the whole of the evidence
- **The commands have only been exercised in a simulated page**, not by hand in the real window —
  see the note in `docs/ROADMAP.md` about what is not covered by automation
- The app cannot see, search, or act on anything outside the conversation; she is instructed to
  say so plainly rather than invent a result

## Roadmap

`v0.1` → `v0.2` → ... → `v1.0`, iterating gradually. Each release is a working build; the nine
phases and the reasoning behind them are recorded in `docs/ADR.md`.

Next: **v0.3 — long-term memory**: structured, updatable memories linked to the messages they came
from, which is the feature the third recorded conversation was already asking for.

## License and notices

- Apache License 2.0, © 2026 Chengzhibense (see `LICENSE` / `NOTICE`)
- The released exe bundles **Electron** (MIT, © Electron contributors) and Chromium; their notices
  (`LICENSE.electron.txt`, `LICENSES.chromium.html`) ship beside the executable and must not be
  removed. See `THIRD_PARTY_NOTICES.md`
- Visual assets originate from **Fairy-DSH-main** (the `dsh-fairy-visual` plugin); this project
  reuses only its visuals and engineering practices, not its runtime
- **This repository contains no font files, official assets, game text or private corpora**
- The names "Fairy", "DSH" and "DeepSeek" are used for role-play and description only and imply no
  official affiliation with any related party
- This exe **contains no API key**; supply your own. Never package someone else's key into a build
  you distribute
