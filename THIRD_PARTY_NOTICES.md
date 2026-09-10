# Third-party notices

HDD's own code is Apache-2.0 (see `LICENSE` / `NOTICE`). This file records the third-party
components HDD actually uses and the terms that travel with a distributed build.

This project **does not vendor third-party source code**. Everything below is installed by
the package manager, except the visual assets, which are reused from Fairy-DSH.

| Component | Version | License | Role | Copyright |
| --- | --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | `44.3.0` | MIT | Runtime shell; **bundled inside the released exe** | Electron contributors, OpenJS Foundation |
| [Chromium](https://www.chromium.org/) (inside Electron) | as shipped with Electron 44.3.0 | BSD-3-Clause and others | Rendered engine inside the exe | The Chromium Authors and others |
| [Node.js](https://nodejs.org/) (inside Electron) | as shipped with Electron 44.3.0 | MIT | Runtime inside the exe | Node.js contributors |
| [electron-builder](https://github.com/electron-userland/electron-builder) | `26.15.3` | MIT | Build only — not distributed | electron-builder contributors |
| [jsdom](https://github.com/jsdom/jsdom) | `30.0.1` | MIT | Tests only — not distributed | jsdom contributors |
| [@electron/asar](https://github.com/electron/asar) | `3.4.1` | MIT | Packaging and release verification — not distributed | Electron contributors |

## Notices that must travel with a released exe

The build system places these next to the executable automatically; do not strip them:

- `LICENSE.electron.txt` — Electron's MIT notice. MIT requires the copyright and permission
  notice to accompany binary distributions.
- `LICENSES.chromium.html` — Chromium and its bundled components.

Because the exe embeds both, a released build cannot be treated as Apache-2.0-only.

## Visual assets

The mascot SVG, the extracted CSS and the derived palette come from **Fairy-DSH-main**
(the `dsh-fairy-visual` plugin), Apache-2.0, © 2026 Chengzhibense. `MANIFEST.json` records,
per file, whether it is a byte-identical copy ("verbatim-copy") or derived from one. See
`LICENSE` and `NOTICE`.

## Fonts

No font is distributed by this repository, and **no font is embedded in published builds**:
`release.ps1` builds with `HDD_NO_FONTS=1`, so `prep.cjs` registers no `@font-face` at all
and the artifact check fails if font bytes are found inside the asar. Supply your own font
in `app/fonts/` for a local build; the UI falls back to a system sans-serif otherwise.

## Trademarks

"Fairy", "DSH", "DeepSeek", "Zenless Zone Zero" and related names or marks are **not**
licensed by this project. They are used for role-play and description only, and imply no
affiliation with or endorsement by any rights holder.

## Keeping this file honest

A release is the moment to check it: re-read `app/package.json` and the lockfile, and add
any dependency that is new, removed, or bumped. A dependency being pinned does not make it
original content of this project, and an entry here that no longer matches reality is worse
than no entry — this file previously described the upstream DSH host's dependencies
(`hono`, `@playwright/mcp`, …) none of which HDD uses, while omitting Electron entirely.
