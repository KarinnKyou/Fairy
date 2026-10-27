# HDD v0.4

A Fairy-themed desktop terminal: a full-screen window with a centred mascot that changes state as
the conversation progresses, and CMD-style terminal input/output below it. Conversations are driven
by the **DeepSeek API** (SSE streaming).

**This release gives her projects.** Topics can be put into a named container, and when you talk in a
topic that belongs to one, she is also told what else lives in that project — its other topics, and
the newest exchanges from them. It is the first release in this line that adds **no API request**:
membership and context are resolved locally.

---

## Quick start (using the prebuilt exe)

Download the attachment **`HDD-0.4.0.exe`** (single portable file, no install, Windows x64).

> **This exe contains no API key.** You must configure one as described in step 2, or the app
> cannot hold a conversation.

### 1. Run it

Double-click `HDD-0.4.0.exe`. SmartScreen may block it on first launch (unsigned local build) —
choose "More info → Run anyway".

- **Esc** quits
- Type in the input row at the bottom and press **Enter** to send
- Your conversation is saved, and reappears when you open the app again
- Type `/help` for the commands — the five project commands are the new ones

### 2. Configure your API key (required)

A portable exe does **not** read a `config.json` sitting next to it (it unpacks itself into `%TEMP%`
on every launch). Use an environment variable instead:

```powershell
setx DEEPSEEK_API_KEY "sk-your-deepseek-api-key"
```

Then **restart the app** — already-running processes do not see the new variable.

```powershell
setx DEEPSEEK_MODEL "deepseek-v4-flash"            # the model that writes her replies
setx DEEPSEEK_CLASSIFIER_MODEL "deepseek-chat"     # the model that answers the side questions
```

Get an API key at https://platform.deepseek.com.

### 3. Font

**This exe contains no font, and neither does the repository** (licensing). It renders in the system
sans-serif (`Microsoft YaHei` / `Segoe UI`), which is readable but not the intended look.

To build with your own font, place a CJK font in `app/fonts/` and run `npm run dist`;
`scripts/prep.cjs` reads its family name and weight automatically. Builds made by `release.ps1`
deliberately exclude it.

---

## What is new since v0.3

### Projects

| Command | What it does |
| --- | --- |
| `/projects` | Every project, with its topic and message counts; `*` marks the current topic's project |
| `/project` | Which project the current topic belongs to, or that it belongs to none |
| `/project new <名字>` | Create a project and put the current topic in it (one line, up to 40 characters) |
| `/project <序号\|id>` | Put the current topic into an existing project |
| `/project off` | Take the current topic out of its project |

A topic belongs to **at most one** project. `/projects` and `/project` read like the topic commands:
numbers come from the listing, and an id prefix works too.

### What she is told — and what she is not

When the current topic is in a project, the system prompt gains one labelled section:

- the project's name;
- the project's **other** topics, newest first, with their message counts;
- the newest exchanges from those topics, each tagged with the topic it came from.

Three things are deliberate:

- **It is reference, not history.** The block is labelled as other topics' content and is not inserted
  as conversation turns. The current topic's own history is unchanged, and its messages are excluded
  from the block so nothing is said twice.
- **It is bounded.** At most 8 topics, 6 messages and 1000 characters (200 per excerpt). A busy
  project cannot crowd out the prompt budget.
- **It is facts, not a summary.** The app does not generate a project brief. A generated summary would
  let her assert progress the database cannot verify, so she is told only rows that exist.

### One command per topic, on purpose

Nothing is assigned for you: no keyword rule, no model call, and a topic opened by an automatic
boundary does **not** inherit the previous topic's project. A wrong assignment would silently change
what she is told on every turn; `/project <n>` states the right one. The cost is stated plainly —
every new topic in a project needs that one command.

### Repairs that came with it

- **`inspect --prompt` now prints what the app really sends.** It previously omitted the memory
  section; it now uses the same assembly path as a real turn, project block included.
- **A startup failure is a sentence, not silence.** `npm run dev` reports Electron's exit code, and
  a checkout labeled *Low integrity* — which Electron refuses to start from — is named with the
  one-line repair. `main.js` also says so if `ELECTRON_RUN_AS_NODE` is set.
- **Schema v6, still additive.** Migration 6 creates `projects` and adds a nullable
  `topics.project_id`. Existing topics stay unassigned.

---

## Testing it yourself

```
cd app
npm test                                   # 614 assertions, four suites, no network, no window
```

The project commands are covered by the page tests and by a static check that every IPC channel the
preload uses exists in the main process. What no automated test does is type into a real window:

1. `npm run dev:fresh` (or double-click `start-dev.cmd` in the repository root)
2. `/project new HDD`
3. talk a couple of turns, then `/new 发布打包` and talk one more
4. `/project 1` — the new topic joins the project
5. `/project` and `/projects` — the current project and the counts
6. `/project off` — membership goes away

Then inspect what was actually sent:

```
cd app
npm run inspect -- --dev --prompt
```

The printed system prompt should contain the memory section and a `# 当前项目` section with the
project's other topics and their excerpts.

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

If the window never opens:

- `Electron exited with code 2147483651` (`0x80000003`) means Chromium aborted at startup. The cause
  seen in this repository was the checkout labeled **Low integrity**; Electron refuses to start from
  a low-labeled executable. Repair with
  `icacls "<checkout>" /setintegritylevel "(OI)(CI)Medium" /T /C /Q` (README 3.2).
- If `ELECTRON_RUN_AS_NODE` is set, the app runs as plain Node and cannot start; `scripts/dev.cjs`
  clears it for its child.

`app/` and the repository root each have their own `package.json`, and they do not offer the same
scripts: `dev`, `inspect`, `start`, `probe` and `dist` live in `app/`; `test`, `assets:bake` and the
`app:*` wrappers live in the root. The full list is in `docs/COMMANDS.md`.

---

## Known limitations

- **Windows x64 only**, single portable file; always full-screen, no windowed mode; `Esc` quits; no
  cancel for a reply in progress
- **The exe renders in the system font** — the published build excludes the font on purpose (licensing)
- **Projects are curated by hand.** One `/project <n>` per new topic, and no inheritance. If that
  friction is the thing that stops projects from being used, automatic assignment is the deferred
  question (ADR-014)
- **Nothing can rename or delete a project.** A typo stays in `/projects`; deletion needs a
  confirmation design the command surface does not have
- **The project block has not been through a real conversation.** Whether she uses it, and whether she
  mistakes a sibling-topic excerpt for something said just now, is unmeasured. The next real
  conversation is the test
- **The project commands have been exercised in the simulated page, not typed by hand in a real
  window.** The window itself was smoke-started: it opens, and the store is created
- Unchanged: the memory cue misses some facts (a preference inside a request, an identity fact with
  no first-person pronoun), and the topic confirmer sometimes splits short follow-ups more finely
  than a person would. Both are recorded in `docs/eval`
- A subject change still costs one small request, and the reply waits for it; memory extraction runs
  after the reply is on screen. Project context adds no request at all

## Roadmap

`v0.1` → `v0.2` → `v0.3` → `v0.4` → ... → `v1.0`, iterating gradually. Each release is a working
build; the nine phases and the reasoning behind them are recorded in `docs/ADR.md`.

Next: **v0.5 — files, chunks and semantic retrieval**, where the vector-store decision is due at the
start of the phase (ADR-007).

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
