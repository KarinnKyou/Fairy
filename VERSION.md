# HDD — version record

## 0.3.0 (release name: HDD-0.3.0)

Phase 3: she remembers. Stable facts about the owner — where they live, what they work on, what
they like — are learned as you talk, linked to the messages they came from, and used in later
conversations.

**This release also fixes a defect in v0.2.** The topic confirmation request was capped at 80
output tokens, and the configured model is a *reasoning* model: it spends the budget thinking and
then has nothing left to write the answer with. Measured on a replayed real conversation, 8 of 13
calls returned nothing — and because an unreadable answer means "stay in the current topic", topic
splitting appeared to work while mostly not happening. Both side requests now go to a
non-reasoning model (`deepseek-chat` by default, configurable), with room to answer.

### What is new

- **Memories, with a decision behind each one.** A cheap local rule (`app/memory.js`) decides when
  a turn is worth *asking about*; only then does one small request go out asking what is worth
  keeping. Every failure — no key, a timeout, an answer that cannot be read — remembers nothing,
  because an extractor that cannot answer must not be able to invent a fact about the owner.
- **Nothing is overwritten.** A correction appends a new memory and marks the old one superseded,
  so what she used to believe, and when it changed, stays readable. `/forget` is deliberately
  different: it deletes the fact **and every earlier version of it**, because a person asking for
  something to be gone is not the same as the app correcting itself.
- **Every memory is traceable.** Each one is linked to the messages it came from, and `/memories`
  shows whether it came from something you stated or was inferred, and how many messages it was
  drawn from.
- **Three commands, no new CSS:** `/memories`, `/remember`, `/forget` — reusing the same `.line`
  elements as everything else, so the mask, `pinBottom()` and the font-weight override are
  untouched.
- **Memories are bounded twice** on the way into the prompt — twenty of them, twelve hundred
  characters, newest first — because ADR-008 warns about the prompt budget and a memory is a
  sentence, not a word.
- **The capability declaration gained `memory`,** and the cross-check that enforces it compares the
  declaration against the *assembled prompt* rather than against a function name, so it keeps
  working only while the injection is really called.
- **Schema v5**, still additive: migration 5 adds `memories` and `memory_sources`, with the source
  links enforced by foreign keys and a `CHECK` that keeps a supersession from being written half
  way. Migration 4 added `topics.title_locked`.
- **A headless probe** (`npm run probe`), so the two requests that need a network can be run and
  inspected without opening a window: it replays a recorded conversation, asks the real model, and
  writes every prompt, answer and stored memory to a report file. `--corpus` also compares the
  model's verdicts against the recorded human judgement, which no offline test can do.
- **A packaging check in the test suite.** `build.files` is hand-maintained and had now been
  forgotten three times, most recently for the two modules this release adds — a packaged v0.3
  would have died on startup. The test walks the `require` graph in seconds instead of waiting for
  a release build to fail.

### Known limitations

- **Two requests now run besides the reply.** One decides a topic boundary and the reply waits for
  it; the other extracts memories and runs *after* the reply is on screen, so it delays nothing.
  Measured on a replayed conversation: 10 boundary calls and 2 extraction calls over 15 turns.
- **The memory cue misses facts.** Two of the fifteen real turns held a fact that should have been
  remembered and was not asked about: a preference stated inside a request, and an identity fact
  with no first-person pronoun. Loosening the cue would catch them and would spend a request on
  every turn shaped like 帮我…, which is the most common shape there is. Both misses are recorded as
  assertions in `docs/eval/memories-2026-09-14.json`.
- **The topic confirmer over-splits short follow-ups**, measured twice: three short capability
  questions became three topics where one would do. Recorded rather than acted on — one
  conversation is not enough to change a prompt for.
- **The commands have still never been driven by hand in a real window**, except `/memories`. They
  are covered by jsdom and by a static cross-check that every IPC channel the preload uses exists
  in the main process. `main.js`'s handlers have never been exercised outside a real launch.
- Windows x64 only, one portable exe, always full-screen, `Esc` to quit, no cancel for a reply in
  progress.
- **The published exe contains no font** and renders in the system sans-serif (ADR-011).
- The packaged data-directory branch (`app.getPath('userData')`) is still not covered by the
  automated tests; it is verified by launching the built exe.

The interface invariants listed under 0.0.1 (font-weight override, fade mask on `#out`,
unconditional `pinBottom()`) still hold and are still asserted by the tests. `npm test` reports
548 passing assertions across four suites.

## 0.2.0 (release name: HDD-0.2.0)

Phase 2: the conversation stopped being one undifferentiated transcript. It is split into
**topics** — subjects — as it happens, and switching between them changes what she is reminded
of, not merely what is on screen.

### What is new

- **Topics, with a boundary that is decided rather than guessed.** A cheap local rule
  (`app/topics.js`) watches for a message that shares almost no vocabulary with the current
  subject; only then is the model asked one small question — same subject, or a new one? A new
  topic is opened **only** on an explicit "yes". If the request fails, times out, cannot be
  parsed, or there is no API key, the message stays where it is: a classifier that cannot answer
  is never allowed to invent a boundary. With no key the app degrades to one topic per sitting.
- **The model also names the topic**, on either answer, so a session that opens with a greeting
  is not titled after whatever sentence followed it. Titles are noun phrases; `/rename` overrides
  one, and a name the user chose is never touched again.
- **Topics select context.** The history sent to the model is the current topic's history, so
  switching changes what she knows. The profile (first meeting, turns spoken) stays global — that
  is about the relationship, not a subject.
- **Six commands** on the existing input line: `/topics`, `/switch`, `/new`, `/rename`,
  `/search`, `/help`. They print through the same elements as everything else, so **no CSS, no
  layout and no visual rule changed** — the mask, `pinBottom()` and the font-weight override are
  the same code as in 0.1.0.
- **Full-text search you can reach** (`/search`), across every topic, Chinese included, with the
  topic each hit came from. This is FTS5, not semantic retrieval — that is Phase 5 (ADR-007).
- **An evaluation set built from real conversations.** `docs/eval/` holds three transcripts kept
  verbatim with a human judgement recorded for every turn — 27 turns in total — and the tests
  replay them, driving the confirmer with the recorded judgement so that everything except the
  model's own quality is asserted offline. It found a defect on first use.
- **Schema v4**, still additive: migration 3 adds `topics` and a nullable `messages.topic_id`
  plus an index; migration 4 adds `topics.title_locked` for provisional names. A v0.1 store
  upgrades in place — its single implicit conversation becomes exactly one topic, titled from the
  earliest user message and locked, so a later sentence cannot rename hundreds of messages.
- **`inspect` shows topics**: each message is tagged with the topic it landed in, and `--topic N`
  prints one topic; `--prompt` describes the topic in progress, because that is what the next
  turn would actually send.

### Known limitations

- **A boundary can cost a request, and the reply waits for it.** One extra small call on turns
  that look like a change of subject — measured on one real 15-turn conversation, 10 of them.
  This is the deliberate price of deciding boundaries instead of guessing them; the transcript it
  replaced split a single project into three topics.
- **The local thresholds are still estimates.** `MIN_PROPOSAL_TERMS` 3, `MIN_SHARED_TERMS` 2,
  `PROPOSE_COVERAGE` 0.15, `IDLE_COVERAGE` 0.35, `IDLE_GAP_MS` 6 h. They have been corrected twice
  by real conversations, after reasoning alone had twice been confidently wrong. Three
  transcripts are the whole of the evidence (ADR-012).
- **Topic quality depends on the model's verdict.** It has been observed right on every turn of
  the third recording, but that is 15 turns.
- **The command surface has never run in a real window.** Electron cannot start in the
  environment this build was developed in, so `/topics`, `/switch`, `/new`, `/rename`, `/search`
  and `/help` are covered by jsdom and by a static cross-check that every IPC channel the preload
  uses exists in the main process — not by hand. `main.js`'s handlers have never been exercised
  outside a real launch, which is also true of the 0.1.0 build.
- Windows x64 only, one portable exe, always full-screen, `Esc` to quit, no way to cancel a reply
  in progress.
- **The published exe contains no font** and renders in the system sans-serif (ADR-011): the font
  is the developer's own licensed file and a published artifact must not redistribute it. A local
  `npm run dist` still embeds it.
- The packaged data-directory branch (`app.getPath('userData')`) is still not covered by the
  automated tests, and is verified by launching the built exe.

The interface invariants listed under 0.0.1 (font-weight override, fade mask on `#out`,
unconditional `pinBottom()`) still hold and are still asserted by the tests.

## 0.1.0 (release name: HDD-0.1.0)

Phase 1: the conversation became real. `0.0.1` showed the look; this build remembers what
was said, and the state lives in a database instead of nowhere.

### What is new

- **Conversations persist.** The main process owns them in SQLite
  (`app/data/hdd.db` in development, `%APPDATA%\HDD\data\hdd.db` when packaged) and the
  window redraws the transcript on launch, so quitting no longer loses the conversation.
- **Context is assembled per turn** from the store: system prompt → profile → the most
  recent 30 messages. The renderer no longer builds any prompt.
- **The profile accumulates**: turns spoken, first meeting, last seen. Injected from the
  second turn onward.
- **Fixed: the current question was never sent.** The message the user had just typed was
  captured before it was appended and then dropped, so replies answered the *previous*
  question. The last message sent is now always the user's, and a test asserts it.
- **Replies are one terminal line.** Newlines collapse to a single space; a model writing
  `\n\n` used to produce a blank line in the transcript.
- **Persona cut back on purpose** (~500 characters): identity, capability boundary, speech
  rules. The full character is deferred to v1.0 (ADR-008) — writing it now would mean
  describing abilities the build does not have.
- **Schema migrations** with a loud refusal to open a newer database, an FTS5 full-text
  index with CJK unigram tokenisation (no UI yet — that is Phase 2), and stable sortable
  IDs.
- **Developer tooling**: `npm run dev` / `dev:fresh` keep test chatter out of the real
  store, and `npm run inspect` prints the transcript and, per reply, how many messages
  went to the model and how long the system prompt was.

### Known limitations

- Windows x64 only, one portable exe, always full-screen, `Esc` to quit.
- **The published exe contains no font** and therefore renders in the system sans-serif.
  The font is the developer's own licensed file (ADR-011); a released artifact must not
  redistribute it, so a public build cannot carry it. A local `npm run dist` still embeds
  it. This is a deliberate visual regression against the 0.0.1 demo, which did embed it.
- No cancel button: a reply in progress cannot be interrupted.
- One implicit conversation — no topics, no switching (Phase 2).
- The packaged data-directory branch (`app.getPath('userData')`) is not covered by the
  automated tests, which run outside Electron. It was verified by launching the built exe
  and confirming it created `%APPDATA%\HDD\data\hdd.db` at schema version 2 — and that the
  store reopened cleanly after the app was killed without a shutdown.

The interface invariants listed under 0.0.1 (font-weight override, fade mask on `#out`,
unconditional `pinBottom()`) still hold and are still asserted by the tests.

## 0.0.1 (release name: HDD-0.01)

Frozen build. Everything below is verified on this exact tree.

### Interface

- Full-screen terminal; `Esc` exits.
- Mascot centred, above the text layer (`z-index` 20 vs 5).
- Output text is anchored to the bottom and grows upwards; old lines are pushed up.
- **Fade mask:** centred ellipse on the non-scrolling scroll container `#out`
      `radial-gradient(ellipse 78vmin 58vmin at 50% 46%, transparent 0 42%, .55 66%, #000 92%)`
  Text dims as it approaches the mascot.
- **Auto-pin:** the newest content always stays just above the input row, so the user
  never has to scroll down manually.
- Input row is the last line of the same flow (it scrolls with history).
- Typewriter output, per-turn glitch effect, emoji stripping, persona prompt.

### Known invariants (do not break)

1. **Font weight override.** `assets/css/fairy-hdd-theme.css` ships
   `html[data-dsh-fairy-visual] body :where(*) { font-weight: 800 !important }`, which
   hits every element. The bundled font has a single weight (400, no `fvar` axis), so
   800 makes Chromium synthesize a fake bold that blurs CJK text. The override in
   `app/src/live.template.html` (with the `#hdd-root` id on `<html>` for specificity)
   must stay.
2. **The fade mask lives on `#out`, never on `#log`.** `#log` scrolls with the content,
   so a mask there scrolls away and stops working entirely.
3. **`pinBottom()` scrolls unconditionally.** The 24px "user scrolled up" threshold in
   `scrollBottom()` misreads each appended line as a manual scroll, and the offset
   accumulates (48/96/144...).

### Verification

```sh
npm test            # from the project root: asset bake + all four suites
# or, from app/:  npm run test:store && npm run test:conversation && npm run test:ui
```

- `store.test.cjs` — schema, migrations, ID ordering, CJK full-text search.
- `conversation.test.cjs` — the user's current message is the last message sent; prompt
  assembly; persona scope and length ceiling.
- `renderer.test.cjs` — layout/mask/typewriter/emoji+newline/weight-override assertions.
- `scroll-pin.test.cjs` — 12 turns; distance-to-bottom stays 0 on every turn.

### Build

```sh
cd app
npm run dist        # -> app/dist/HDD-<version>.exe  (portable, x64)
```

Note: `npmRebuild` is set to `false` in `app/package.json`. The project has no native
dependencies, and electron-builder's rebuild step spawns a child process that some
sandboxed environments deny (`spawn EPERM`).

The demo executable was built with a **placeholder API key** in `app/config.json`
(`sk-REPLACE_WITH_YOUR_DEEPSEEK_API_KEY`). Anyone running it must supply their own key
via `app/config.json` or the `DEEPSEEK_API_KEY` environment variable. Do not ship an
executable built with a real key.

### Maintenance tools (not part of the app)

- `app/scripts/prep.cjs` — assembles `www/` from the template, assets and fonts.
- `app/scripts/icon.cjs` — regenerates `build-res/icon.png`.
- `app/scripts/dev.cjs` — launches with an isolated data dir under `%TEMP%`, so manual
  testing never touches `app/data/`. `--fresh` wipes that dir first.
- `app/scripts/inspect.cjs` — prints schema version, turn count and recent messages from
  the store, for checking that a session really persisted what it should have.

### Not covered by automated tests

Rendering it is the only way to judge the fade by eye. Nothing in CI can assert how
the mask *looks*; the tests assert its exact form instead.
