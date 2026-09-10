# HDD

**HDD** is a "Fairy" desktop terminal. In a full-screen window, a centred Fairy mascot
switches state automatically as the conversation progresses, with CMD-style terminal
input and output below it (no bubbles, no prompt text). Conversations are driven by the
**DeepSeek API** (`deepseek-v4-flash`, SSE streaming). Visual assets are extracted from
Fairy-DSH-main (the `dsh-fairy-visual` plugin); the desktop shell is Electron and the
page itself is fully local (CSP blocks network access).

> License: Apache License 2.0, © 2026 Chengzhibense (see `LICENSE` / `NOTICE` /
> `THIRD_PARTY_NOTICES.md`).
> "Fairy / DeepSeek / related games and trademarks" are not covered by this license;
> this project contains no official assets, game text or private corpora.

---

## 1. Features

- **Full-screen desktop terminal** (title `HDD`), `Esc` to quit
- Mascot strictly centred; history text **fades out** as it rises toward the centre and
  never covers the mascot
- Replies appear with a **per-character typewriter** effect; state switches automatically:
  - idle = normal
  - model reasoning (`reasoning_content` in the stream) = thinking
  - reply body (`content` in the stream) = "speaking" = comforting
  - every state change is accompanied by a **random glitch effect**
- **Terminal-style I/O**: no bubbles, no hint text, no input placeholder; the input row
  grows upward from the bottom together with history
- **Emoji are banned**: enforced by the system prompt plus a Unicode scrub in the view layer
- **Self-identity = Fairy**: the system prompt forbids claiming to be DeepSeek / OpenAI
  or any other model
- Font size, weight and column width are CSS variables, all easy to tune

## 2. Requirements

| Item | Requirement |
| --- | --- |
| OS | Windows x64 (the release artifact is a portable exe) |
| Node.js | ≥ 20 (only needed to develop/package; the built exe does not need Node) |
| Network | `https://api.deepseek.com` must be reachable at runtime (main process only) |
| Font | **You must supply your own** (see 3.0): drop a `.ttf/.otf/.woff/.woff2` into `app/fonts/` and `prep` registers it automatically |

## 3. Getting started

### 3.0 Provide a font (optional, but strongly recommended)

This repository **does not include any font files** (licensing). Supply your own CJK
font by placing it in `app/fonts/`; during the build `scripts/prep.cjs` reads its family
name and weight and generates the `@font-face` rule. **No configuration is needed.**

- The app runs without a font, falling back to the system sans-serif
  (`Microsoft YaHei` / `Segoe UI`), but loses the intended look.
- If your font has a **single weight** (as the heavy CJK face originally used here does),
  keep `--fairy-weight: 400` consistent with it. Setting a weight the font does not have
  triggers the browser's synthetic bold, which blurs CJK text.

### 3.1 Configure the API key (required)

The app reads `app/config.json`; environment variables take precedence:

```jsonc
// app/config.json (template: app/config.example.json)
{
  "apiKey": "sk-...your DeepSeek API key...",
  "model": "deepseek-v4-flash",
  "baseUrl": "https://api.deepseek.com"
}
```

- `app/config.json` is excluded by `.gitignore` — never commit it.
- `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` override it (**environment variables win over
  `config.json`**).
- **Running from source and running a packaged build read the same `config.json`, but the
  packaged build embeds a snapshot of it.** An exe built with your real key is a
  **private build** containing that key — **do not distribute it**. To publish a demo,
  replace `app/config.json` with a placeholder value before packaging.
- **A portable exe does not read a `config.json` next to the exe.** It unpacks itself
  into `%TEMP%` on every launch and the code reads the copy inside that unpacked
  directory. To give an already-built exe a key, use the environment variable
  (`setx DEEPSEEK_API_KEY "sk-..."`, then restart the process) or rebuild.

### 3.2 Running in development

```sh
cd app
npm install            # first time only (downloads Electron, ~120MB)
npm start              # runs prep (generates www/) then opens the dev window
```

### 3.3 Building the release (single portable exe)

```sh
cd app
npm run dist           # -> app/dist/HDD-0.01.exe, ready to run
```

### 3.4 Tests and asset rebuild (from the project root)

```sh
npm run assets:bake    # re-bake visual assets and refresh assets/MANIFEST.json
npm run app:test       # prep, then run the renderer regression tests (jsdom)
npm test               # = assets:bake + app:test
npm run app:dist       # same as 3.3
```

## 4. Usage

1. Double-click `HDD-0.01.exe` → full-screen window: Fairy in the centre, a blank input
   row at the bottom (block cursor).
2. Type text and press **Enter** to send. Fairy enters the thinking state (with a glitch
   flicker), then types the reply out character by character in the comforting state and
   returns to normal when finished.
3. Press **Esc** to quit. Clicking anywhere in the text area refocuses the input row.
4. The glitch/flicker is purely visual and does not affect the conversation.

## 5. Project structure

```
HDD/
├── README.md                  ← this document
├── package.json               ← root aggregate scripts (assets:bake / app:test / ...)
├── LICENSE / NOTICE / THIRD_PARTY_NOTICES.md
├── MANIFEST.json              ← asset manifest: origin mapping + SHA-256
├── VERSION.md                 ← version record and invariants
├── assets/                    ★ reusable visual asset layer (decoupled from the app)
│   ├── bake.cjs               ← asset baker (SVG output / CSS extraction / tokens / manifest)
│   ├── source/                ← asset source modules (verbatim copies, do not edit)
│   │   ├── mascot-geometry.js      eye geometry parameters
│   │   ├── mascot-eye-svg.js       main SVG (gradients / interference filter / glitch slices)
│   │   ├── mascot-effects-svg.js   halo + lash pulse
│   │   ├── mascot-style.js         mascot animation/state CSS
│   │   └── esm/{constants.js, style.js, package.json}
│   │                               source for the injected theme CSS
│   ├── svg/                   ← baked output: fairy-eye (±thinking/comforting)/halo/pulse
│   ├── css/                   ← extracted output: fairy-mascot.css / fairy-hdd-theme.css
│   ├── tokens/                ← palette / variables / font stats (fairy-palette.json)
│   └── preview.html           ← asset gallery (open in a browser to inspect assets and palette)
└── app/                       ★ Electron application (consumes assets/ to build www/)
    ├── package.json           ← app package: prep / icon / start / dist scripts + builder config
    ├── main.js                ← main process: full-screen window, Esc, DeepSeek SSE proxy (IPC)
    ├── preload.cjs            ← secure bridge: getConfig / ask / onStream (contextBridge)
    ├── config.json            ← private config (key/model; gitignored)
    ├── config.example.json    ← config template
    ├── fonts/                 ← UI font (**supply your own**; not in this repo — see 3.0)
    ├── build-res/             ← app icon (icon.png generated by scripts/icon.cjs)
    ├── scripts/
    │   ├── prep.cjs           ← assembles www/: injects SVG, copies css/svg, registers fonts
    │   ├── icon.cjs           ← generates the eye icon procedurally (pure Node, no deps)
    │   ├── fade-rect-plan.cjs ← converts the elliptical mask into rectangular breakpoints
    │   └── build-mask-probe.cjs ← writes www/mask-probe.html, a mask comparison page
    ├── tests/renderer.test.cjs  ← jsdom renderer regression tests
    ├── tests/scroll-pin.test.cjs← auto-scroll regression tests
    ├── src/live.template.html ← page template (@@FAIRY_*@@ placeholders injected by prep)
    ├── www/                   ← generated by prep (gitignored)
    └── dist/                  ← release artifact: HDD-0.01.exe (gitignored)
```

### Layered design (extensibility)

| Layer | Responsibility | How to extend |
| --- | --- | --- |
| `assets/` | Single source of truth for visual assets: source modules + generated output + manifest | Add/modify assets → re-bake with `assets/bake.cjs`; dropping a font into `app/fonts/` registers it automatically |
| `app/` | Desktop app: window / secure IPC / page / styles / packaging | Edit `app/src/live.template.html` or `app/main.js`, then run `prep` and `dist` |
| Renderer | Pure local page, no Node, no network (CSP `connect-src 'none'`) | The API key stays in the main process; the renderer only talks through the preload bridge |

## 6. Technical notes

- **Security boundary**: renderer runs with `sandbox + contextIsolation` and a
  network-blocking CSP; model requests are only made from the main process.
- **Streaming state machine**: `delta.reasoning_content` → thinking;
  `delta.content` → speaking (comforting).
- **Typewriter**: content is queued and emitted one character at a time (the queue speeds
  up when it grows); `done` waits for the queue to drain before finishing the turn.
- **No emoji**: system prompt plus a second scrub in the renderer over
  `Extended_Pictographic` and related ranges.
- **Font**: supply your own in `app/fonts/`. Tuning is in section 7.
- **Centring and fade**: the mascot is fixed at 50%/50% with `translate(-50%,-50%)`;
  the text layer is `z-index: 5` and the mascot `z-index: 20`. The output container
  carries a centred radial mask, and it must live on `#out`

## 7. Tuning (all in the CSS at the top of `app/src/live.template.html`)

| Desired effect | What to change |
| --- | --- |
| Font size (28–32) | `body { --fairy-size: 30px; }` |
| Font weight | `--fairy-weight: 400` (**must match the font's actual weight**, see 7.1) |
| Column width | `.line, #inputline { max-width: min(1500px, calc(100vw - 120px)); }` |
| State-change glitch duration | `glitchFx(180 + Math.random() * 240)` in the JS |

> **About text stroke**: two approaches were tried and **both were removed**. `.line` and
> `#term-input` are now `text-shadow: none` — there is no stroke.
>
> - `-webkit-text-stroke` is a **centred** stroke (half inside, half outside the glyph)
>   and eats into the letterforms.
> - A true outer stroke is not available for HTML text: Chromium's
>   `paint-order: stroke fill` **only applies to SVG text**. It can only be approximated
>   with eight offset `text-shadow` layers.
>
> Both were removed because this font is extremely dense — 88.2% ink coverage
> (Microsoft YaHei: 50.6%) with stems of 0.192 em (Black/Heavy territory) — so its
> counters are already very narrow. Any extra stroke adds ink outward and squeezes the
> counters further, which can only hurt legibility. Measured ink growth from the
> eight-layer approach was `0.5px → +15%`, `0.7px → +21%`, `1.0px → +30%`.
> **If you reintroduce a stroke, restore the matching test assertions too.**

### 7.1 The font-weight override (important, do not delete)

`assets/css/fairy-hdd-theme.css` (an asset extracted from Fairy-DSH) contains a
**global rule**:

```css
html[data-dsh-fairy-visual] body,
html[data-dsh-fairy-visual] body :where(*) { font-weight: 800 !important }
```

It matches **every element** in the terminal. The bundled font has a single weight
(400, `usWeightClass=400`, no `fvar` axis), so forcing 800 leaves Chromium with
**synthetic bold (faux bold)** — it smears the glyphs sideways to fake weight, and since
CJK is already stroke-dense the details **blur into a mush**.

More subtly: the `font-weight: var(--fairy-weight, 400)` on `body` has a specificity of
only `(0,0,1)` and **loses** to that rule. `--fairy-weight` was also never defined
(`var()` falls back only when the variable is *undefined*; if it is defined but empty the
whole declaration is dropped) — so the weight was **in fact always 800**.

For that reason `app/src/live.template.html` keeps this override. **Do not remove it:**

```css
#hdd-root[data-dsh-fairy-visual] body #out,
#hdd-root[data-dsh-fairy-visual] body #out *,
/* ... #log / #inputline / #term-input are listed alongside ... */
{ font-weight: 400 !important }
```

Key points:

- The `#hdd-root` id on `<html>` lifts specificity to the `(1,1,n)` level so it reliably
  beats the theme's `(0,1,1)`.
- It must cover **every descendant** of `#out`, because the theme's `:where(*)` matches
  each element.
- Use a **literal** `400`, never `var(...)`: when a value contains `var()` some CSS
  parsers (jsdom/cssstyle) drop the `!important`, silently disabling the override.
- The text is bright and the font is heavy, so a hijacked weight of 800 reads as both
  "bolder" and "blurrier" at once — which was long misdiagnosed as a font design problem.

> Note: **jsdom resolves the CSS cascade by document order and ignores specificity**
> (verified: a higher-specificity rule placed earlier loses), so the **runtime effect of
> this override cannot be verified by the jsdom regression tests**; they only assert that
> the rule exists and is shaped correctly. If the theme CSS is ever replaced, re-check the
> weight in a real browser.

## 8. Tests

```sh
# Renderer regression (jsdom; covers sending, thinking/comforting states, typewriter,
# emoji scrubbing, layout assertions, and the font-weight override)
npm run app:test
```

The tests never touch the network and never start Electron. `app/tests/renderer.test.cjs`
injects a fake `fairyApp` and drives the full "send → reasoning → content → done" flow.
The layout assertions expect the **current** mask (a centred radial
`radial-gradient(ellipse 78vmin 58vmin at 50% 46% ...)` on `#out`); update them together
with the mask.

`app/tests/scroll-pin.test.cjs` drives 12 turns and asserts the newest reply always stays
visible above the input row, with no accumulating drift.

## 9. Troubleshooting

- **SmartScreen blocks the exe**: it is unsigned; choose "More info → Run anyway".
- **Errors or no output**: check that `api.deepseek.com` is reachable and that the key in
  `config.json` is valid. `npm start` shows the console; errors are printed as `! ...` lines.
- **The UI font did not change**: make sure a font file exists in `app/fonts/`, then re-run
  `npm run prep` and `dist`.
- **Changing key/model**: edit `app/config.json` (or set the environment variables) and
  restart; re-run `npm run dist` to repackage.
- **Replacing the mascot or adding weights**: see the layered design in section 5.

## 10. Credits

- Visual assets originate from **Fairy-DSH-main** (`dsh-fairy-visual`, Apache-2.0,
  © 2026 Chengzhibense). The original plugin targets the DeepSeek Harness web client;
  this project only reuses its visuals and engineering practices, not its runtime.
- The DeepSeek API provides conversational inference. The names `Fairy` and
  `HDD / Hollow Deep Drive` are used for role-play within this project only and imply no
  official affiliation with any related party.
