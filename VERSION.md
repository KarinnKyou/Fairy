# HDD — version record

> **The tree is ahead of the last release.** `0.0.1` (below) records the demo that was
> built and attached to the `v0.01` release, not the current working tree. Since then the
> app gained a persistent SQLite store, main-process-owned turns with history restore, a
> deliberately minimal persona, and one-line replies (newlines folded to spaces). Those
> are unreleased and untagged; the next version section is written when they are packaged
> and verified.

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
