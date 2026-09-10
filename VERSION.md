# HDD — version record

## demo-1.0.0 (current)

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
cd app
npm run test:ui     # or: node tests/renderer.test.cjs && node tests/scroll-pin.test.cjs
```

- `renderer.test.cjs` — layout/mask/persona/typewriter/emoji/weight-override assertions.
- `scroll-pin.test.cjs` — 12 turns; distance-to-bottom stays 0 on every turn.

### Build

```sh
cd app
npm run dist        # -> app/dist/HDD-1.0.0.exe  (portable, x64)
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
- `app/scripts/fade-rect-plan.cjs` — converts the elliptical mask into equivalent
  breakpoints for a rectangular fade; useful when tuning the fade.
- `app/scripts/build-mask-probe.cjs` — writes `www/mask-probe.html`, a side-by-side
  mask comparison page. Run it, open the page in a browser, then delete the file.

### Not covered by automated tests

Rendering it is the only way to judge the fade by eye. Nothing in CI can assert how
the mask *looks*; the tests assert its exact form instead.
