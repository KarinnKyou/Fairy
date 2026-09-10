# Development commands

Every command you need for running, testing and shipping HDD, with the directory it must be
run from. Two `package.json` files exist and **they do not offer the same scripts**, which
is the most common way to waste five minutes here:

| Directory | Offers |
| --- | --- |
| repository root (`D:\Coding\HDD`) | `test`, `assets:bake`, `app:prep`, `app:test`, `app:start`, `app:dist` |
| `app/` | `start`, `dev`, `dev:fresh`, `inspect`, `inspect:dev`, `prep`, `icon`, `dist`, `test:store`, `test:conversation`, `test:ui` |

Running a script that belongs to the other one fails with `Missing script` — nothing is
broken, you are just in the wrong directory.

---

## 1. Talk to her for real

```powershell
cd D:\Coding\HDD\app
npm start                 # prep, then open the window; data goes to app/data/hdd.db
```

Use this when you want a conversation you intend to keep. `Esc` quits.

## 2. Talk to her without polluting the real history

You will open the app constantly and ask the same things. Those throwaway turns would pile
up in the real store and make the profile facts ("first time we met", "turn N") meaningless,
so these launch with `HDD_DATA_DIR` pointed at a scratch directory
(`%TEMP%\hdd-dev-data`, kept between runs):

```powershell
cd D:\Coding\HDD\app
npm run dev                          # scratch store, kept between runs
npm run dev:fresh                    # wipe the scratch store first — clean slate
npm run dev -- --dir D:\scratch      # or point it at a directory of your choosing
```

From the repository root the same thing exists as `npm run app:start`, but **not** as
`npm run dev`.

## 3. Tests

```powershell
cd D:\Coding\HDD
npm test                  # asset bake + all four suites (this is the real gate)
npm run app:test          # the four suites only, no bake
npm run assets:bake       # only re-bake assets/svg, assets/css, assets/tokens, MANIFEST.json
```

Individually, from `app/`:

```powershell
cd D:\Coding\HDD\app
npm run test:store        # SQLite: schema, migrations, ID ordering, CJK full-text search
npm run test:conversation # prompt assembly, persona scope, turn bookkeeping
npm run test:ui           # prep + renderer and scroll-pin (jsdom, no window opens)
```

Tests never touch the network and never open a window. `npm test` is what `release.ps1`
runs before building, and a red suite blocks the release.

> `npm test` includes `assets:bake`. Baking is reproducible: unchanged sources produce
> byte-identical output, so a clean tree stays clean. If it *does* report changes, a source
> asset really changed and those changes belong in a commit.

## 4. Finding out what actually happened

The database is binary, so this is the way to read it — and, more usefully, to see exactly
what was sent to the model. **Run this before theorising about a bad reply.**

```powershell
cd D:\Coding\HDD\app
npm run inspect                      # the real store (app/data)
npm run inspect:dev                  # the scratch store used by npm run dev
npm run inspect:dev -- --prompt      # also print the full system prompt
```

It prints the transcript, the profile facts (first seen, turns, last seen) and, per reply,
how many messages went to the model and how long the system prompt was:

```
[15:58:02] user      你好
[15:58:02] assistant 主人，你好。  [context: 9 msg, system 812 ch]
```

That `context:` figure separates "no history was sent" from "history was sent". The app
also logs the same numbers to the console on every turn.

## 5. Resetting data

```powershell
cd D:\Coding\HDD\app
node -e "console.log(require('./store.js').resetDataDir('data',{force:true})+' files removed')"
```

`resetDataDir` refuses to delete anything without `{force:true}`, so a stray call cannot
cost you a conversation. The packaged app's store lives at `%APPDATA%\HDD\data\hdd.db`
and is not touched by any of the above.

## 6. Packaging and releasing

```powershell
cd D:\Coding\HDD
.\release.ps1 -Version 0.2.0 -DryRun      # show the plan, change nothing
.\release.ps1 -Version 0.2.0 -NoPush      # bump, test, build, verify, commit — stop before push
.\release.ps1 -Version 0.2.0              # the full ritual, then push and publish
.\release.ps1 -Version 0.2.0 -VerifyOnly  # re-run only the artifact checks on app\dist
```

A local build **with your font** (for your own use — this is not what gets published):

```powershell
cd D:\Coding\HDD\app
npm run dist              # -> app/dist/HDD-<version>.exe
```

`release.ps1` sets `HDD_NO_FONTS=1`, so a published artifact contains no font bytes and
renders in the system sans-serif (ADR-011). `npm run dist` on its own still embeds it.

Before touching anything about the release path, know what the checks do: they verify the
packaged asar contains no real API key, that every module the app `require`s is actually
inside it, and that no font files are embedded. `-VerifyOnly` exists so those checks can be
pointed at a deliberately broken build and shown to fail — do that if you change them.

## 7. Environment variables

| Variable | Effect |
| --- | --- |
| `DEEPSEEK_API_KEY` | API key; wins over `app/config.json`. Required for a packaged exe |
| `DEEPSEEK_MODEL` | Model name, e.g. `deepseek-v4-flash` |
| `HDD_DATA_DIR` | Where the store lives. Set by `npm run dev` |
| `HDD_NO_FONTS` | `1` = register no font (used by `release.ps1`) |
| `SOURCE_DATE_EPOCH` | Unused by app code; a convention available to the asset bake |

## 8. If something looks wrong

| Symptom | First move |
| --- | --- |
| A reply ignores the question | `npm run inspect:dev` — check `context: N msg`. Zero or tiny means the history never went out |
| Replies look off-topic or answer the previous question | same: confirm the last message sent is the one you just typed |
| CJK text looks blurry | the bundled font has one weight (400); something is overriding `font-weight`. See README 7.1 |
| The UI font is the system font | no font in `app/fonts/`, or you are running `release.ps1`'s build, which excludes it on purpose |
| `Missing script` | wrong directory — see the table at the top |
| `Cannot find module 'node:sqlite'` | Node is older than 22.5; use 24.x |
| `conversation.test.cjs` fails about persona wording | the persona changed. Those assertions encode ADR-008 — decide whether the persona or the assertion is wrong before editing either |
| `conversation.test.cjs` fails about a capability (`工具调用`, `自己上网`, …) | the declaration in `app/capabilities.js` and the code disagree. The test is telling you which: add the capability to `capabilities.js`, or restore the code |
| She claims to have done something she cannot | check the capability block actually reaches the prompt: `npm run inspect:dev -- --prompt` |
