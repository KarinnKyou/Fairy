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

### 1.1 Commands you type to her

A message starting with `/` is a command for the app, handled in the renderer, and never sent
to the model. Anything else is a message for her.

| Command | What it does |
| --- | --- |
| `/help` | The list of commands |
| `/topics` | Every topic, newest activity first, with its message count; `*` marks the current one |
| `/switch <序号\|id>` | Switch to that topic and repaint the transcript from it. The number is the one `/topics` printed |
| `/new [标题]` | Start a new topic and switch to it. Without a title, it takes the name from the next message |
| `/rename <标题>` | Rename the current topic (`/topic` is an alias) |
| `/search <关键词>` | Full-text search across every topic; each hit shows the topic it came from |
| `/memories` | What she currently believes about the owner, where each belief came from, and how many older ones have been superseded |
| `/remember <一句话>` | State a fact about yourself directly. It is recorded as coming from you rather than inferred |
| `/forget <序号\|id>` | Remove a memory, and every earlier version of the same fact along with it |

Things worth knowing, because they are deliberate rather than missing:

- **There is no escape for a literal leading `/`.** A message that starts with `/` is a command;
  an unknown one is reported as unknown rather than passed to her, because silently treating a
  typo as chat makes it look like she ignored an instruction.
- **Switching changes what she is reminded of.** The history sent to the model is the current
  topic's history (ADR-012), so switching is not just a display change. `/topics` is also how you
  find out that an automatic boundary happened where you did not expect one.
- **`/forget` really deletes, and takes the history with it.** A memory the owner removes is gone
  from the database rather than flagged as ignored: an automatic correction and a person asking
  for something to be gone are not the same thing (ADR-013).
- **Memories are text about you, not a search index.** She does not query them; the active ones
  are placed in front of her each turn, newest first, up to a fixed size. `/memories` is the only
  way to see which ones those are.

### 1.2 Reading what the boundary logic did

The app logs one line per turn, and it is the fastest way to tell a boundary that was never
considered from one that was considered and refused:

```
turn t3: topic shift (confirmed: new topic) -> 0001789374921900-0000-0826f930
turn t4: topic shift (confirmed: kept) -> 0001789374412300-0000-1a2b3c4d
turn t5: topic continue (not proposed) -> 0001789374412300-0000-1a2b3c4d
  memory: asked (self) -> stored 1, superseded 0
  memory: skipped (cooldown)
```

- `not proposed` — the message shared enough vocabulary with the current subject; nothing was
  asked, nothing was spent. **This is not automatically correct**: the second real run kept
  「附近有什么好吃的？」 in a film topic this way, because one meaningless two-character match
  cleared the bar. If a subject change is not being caught, this is the line to look at.
- `confirmed: new topic` — the model agreed a subject changed, and this message opened it.
- `confirmed: kept` — the local rule proposed and the model said it was still the same subject.
  This is the case the earlier local-only rule got wrong.
- `staying in the current topic:` on stderr — a confirmation request failed (no key, timeout,
  unparseable answer). The turn continues in the topic it was in.
- `memory: asked (…) -> stored N, superseded M` — the extraction ran *after* the reply reached the
  screen. `superseded` counts beliefs this turn corrected rather than added.
- `memory: skipped (…)` — no request spent. `cooldown` means this topic was asked about recently;
  `nothing` means the turn did not look like a fact about the owner.
- `memory extraction failed, nothing was remembered:` on stderr — every failure remembers nothing,
  because an extractor that cannot answer must not be able to invent a fact about the owner.

`docs/eval/` holds real conversations with a human judgement recorded for each turn, and the tests
replay them: the topic dimension and the memory dimension separately, over the same transcripts.
To add a case, append a turn and its judgement to the JSON — that is the whole mechanism ADR-010
asked for, and it is a data change rather than a code change.

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
npm run inspect:dev -- --topic 2     # only one topic's messages (the number /topics prints)
```

It prints the topics, the profile facts (first seen, turns, last seen) and, per reply, how many
messages went to the model and how long the system prompt was. The `#N` on each line is the
topic, numbered as in the topic list above it:

```
topics          : 2

--- topics (newest activity first) ---
  1. 科幻电影   [1 msg, last 2026/9/14 16:13:20]   <- current
       id: 0001789...-0000-0d356de4
  2. 终端项目   [2 msg, last 2026/9/14 16:12:11]

--- transcript (oldest first) ---
[16:12:11] #2 user      我在做 HDD 这个终端项目
[16:12:11] #2 assistant 主人，我记住了。  [context: 1 msg, system 550 ch]
[16:13:20] #1 user      推荐几部科幻电影
```

Two figures answer two different questions. `context:` separates "no history was sent" from
"history was sent", and `#N` answers *which subject it came from* — a topic boundary in the
wrong place looks fine on the transcript and wrong in the prompt. The app also logs the context
numbers to the console on every turn.

`--prompt` describes the topic that is in progress, because that is what the next turn would
actually assemble; printing the global window there would describe a prompt that never goes out.

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
| `conversation.test.cjs` fails about a capability (`工具调用`, `联网`, …) | the declaration in `app/capabilities.js` and the code disagree. The test says which: declare the capability there, or restore the code |
| `conversation.test.cjs` fails with `prompt 未罗列做不到的项` | something started rendering the absences as a list again. Don't — sharpen the positive statement or the manner rules in the persona instead (ADR-009) |
| She claims to have done something she cannot | check the capability block actually reaches the prompt: `npm run inspect:dev -- --prompt` |
| She seems to have forgotten what you were discussing | `/topics` — an automatic boundary probably landed mid-subject. `npm run inspect:dev` shows which topic each message went to; `/switch` puts you back, `/new` states the intent for next time |
| A topic split in the middle of one subject | expected when the subject is continued in entirely different words: detection is lexical (ADR-012). `/switch`, then `/rename` if the title is misleading |
| A short new request landed in the previous topic | also expected, and the deliberate side of the same trade-off: a message under 8 content terms is never enough evidence to declare a new subject. Use `/new` |
| `/switch 3` says there is no such topic | the numbers come from `/topics` and change as topics are used; an id prefix works too |
