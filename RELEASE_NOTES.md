# HDD v0.3

A Fairy-themed desktop terminal: a full-screen window with a centred mascot that changes state as
the conversation progresses, and CMD-style terminal input/output below it. Conversations are driven
by the **DeepSeek API** (SSE streaming).

**This release gives her memory.** Stable facts about you — where you live, what you work on, what
you like — are learned as you talk, kept with a link back to the messages they came from, and used
in later conversations. She will no longer ask where you live in three days' time.

> **If you are running v0.2, this also fixes a real bug.** Topic splitting there silently failed
> most of the time: the confirmation request was capped at 80 output tokens, the model spent them
> thinking, and the answer never arrived. Nothing looked broken — the app just stopped splitting
> topics. Fixed properly in this release.

---

## Quick start (using the prebuilt exe)

Download the attachment **`HDD-0.3.0.exe`** (single portable file, no install, Windows x64).

> **This exe contains no API key.** You must configure one as described in step 2, or the app
> cannot hold a conversation.

### 1. Run it

Double-click `HDD-0.3.0.exe`. SmartScreen may block it on first launch (unsigned local build) —
choose "More info → Run anyway".

- **Esc** quits
- Type in the input row at the bottom and press **Enter** to send
- Your conversation is saved, and reappears when you open the app again
- Type `/help` for the commands below

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

**About the second variable.** Two small requests run besides the reply: one decides whether the
subject changed, one works out what is worth remembering. Both go to a *non-reasoning* model by
default, because asking a reasoning model to classify something makes it think for hundreds of
tokens first — which, on the request the reply waits for, is both slow and, at a small output
budget, silently answerless. If you leave this unset, `deepseek-chat` is used.

### 3. Font

**This exe contains no font, and neither does the repository** (licensing). It renders in the system
sans-serif (`Microsoft YaHei` / `Segoe UI`), which is readable but not the intended look.

To build with your own font, obtain a CJK font, place it in `app/fonts/` and run `npm run dist`;
`scripts/prep.cjs` reads its family name and weight automatically with **no configuration changes
needed**. Builds made by `release.ps1` deliberately exclude it.

---

## What is new since v0.2

### She remembers

| Command | What it does |
| --- | --- |
| `/memories` | What she believes about you, where each belief came from, and how many older ones have been superseded |
| `/remember <一句话>` | State a fact about yourself directly — recorded as coming from you, not inferred |
| `/forget <序号\|id>` | Forget something, and every earlier version of that fact with it |

- **Nothing is remembered by guessing.** A cheap local rule decides when a turn is worth *asking*
  about; only then is one small request made asking what, if anything, is worth keeping. If the
  request fails, times out, or cannot be read, nothing is remembered — an extractor that cannot
  answer is never allowed to invent a fact about you.
- **Every memory is traceable.** Each one is linked to the messages it came from, and `/memories`
  says whether it came from something you stated or was inferred, and from how many messages.
- **Corrections do not overwrite.** Tell her you have moved and she stores the new city and marks
  the old one superseded, so you can see that it changed and what it changed from. `/forget` is
  different on purpose: it removes the fact and its history, because asking for something to be
  gone is not the same as her correcting herself.
- **Only what is relevant is sent.** Twenty memories at most, twelve hundred characters, newest
  first — she does not carry your whole history into every reply.

### The four things a live run turned up

The probe (below) was built to test the two requests that need a network, and its first real run
found more than it was looking for:

1. **Topic splitting mostly did not happen** (see the note at the top). This affected the released
   v0.2.
2. **New topic names could carry the previous subject over** — 「今天天气不错」 was titled
   「杭州天气闲聊」, because the subject before it had been where you live.
3. **The first topic of a store kept a truncated sentence as its name.** A topic opened by a real
   message locked its name immediately, and the model is only asked when a subject change is
   proposed, so its answer could never replace it.
4. **Memories kept a trailing full stop**, which reads oddly in the list.

All four are fixed, and each was verified back against the live model rather than only in tests.

---

## Testing it yourself

```
cd app
npm run probe                                     # a short scripted conversation
npm run probe -- --corpus docs/eval/topics-2026-09-14-run3.json
npm run probe -- --dry-run                        # prints the prompts, sends nothing
```

No window, no Electron. It drives the real conversation code against the real API in a scratch
store and writes everything it saw — every prompt, every raw answer, what was made of it, what was
stored and where it came from — to `app/data/probe/<timestamp>/`. With `--corpus` it replays a
recorded conversation and compares the model's verdicts against the judgement recorded for each
turn, which is the only way to measure the model rather than the machinery.

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
scripts: `dev`, `inspect`, `start`, `probe` and `dist` live in `app/`; `test`, `assets:bake` and the
`app:*` wrappers live in the root. The full list is in `docs/COMMANDS.md`.

---

## Known limitations

- **Windows x64 only**, single portable file
- **The exe renders in the system font** — the one deliberate way a build looks worse than the
  0.0.1 demo, which embedded a font it should not have been redistributing
- The window is always full-screen; there is no windowed mode. Esc quits
- No cancel button for streaming (a reply in progress cannot be interrupted)
- **A subject change costs one small request, and the reply waits for it.** Work that is worth
  remembering costs one more, after the reply is on screen
- **The cue for "is this worth remembering" misses some facts.** Two real ones were recorded where
  it stayed silent: a preference stated inside a request, and an identity fact with no first-person
  pronoun ("上学好烦啊"). Making the cue broader would spend a request on nearly every turn. Both
  misses are kept as test cases
- **Topic boundaries and names come from a model, and it sometimes splits more finely than a person
  would** — three short follow-up questions in a row became three topics
- **The slash commands have only been exercised in a simulated page**, not by hand in the real
  window
- The app cannot see, search, or act on anything outside the conversation; she is instructed to say
  so plainly rather than invent a result

## Roadmap

`v0.1` → `v0.2` → `v0.3` → ... → `v1.0`, iterating gradually. Each release is a working build; the
nine phases and the reasoning behind them are recorded in `docs/ADR.md`.

Next: **v0.4 — context assembly and projects**, where topics gain projects and the prompt stops
being a fixed window.

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
