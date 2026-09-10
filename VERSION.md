# HDD — version record

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
