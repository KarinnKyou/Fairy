# HDD — roadmap and progress

The nine phases below are assembled from what `docs/ADR.md` says about each one (the ADRs
are authoritative; this file only collects them in one place and records how far along we
are). Each phase ends in a released version, so "Phase 2" and "v0.2" are the same target.

---

## Where we are

| | |
| --- | --- |
| Current release | **v0.3** (`0.3.0`), pre-release, tag `v0.3` |
| Released | 2026-09-15 |
| Artifact | `HDD-0.3.0.exe` (95.5 MB, portable, Windows x64), SHA-256 `B0DFE344…` |
| Release page | https://github.com/KarinnKyou/Fairy/releases/tag/v0.3 |
| Phase in progress | **Phase 4 — context assembly and projects**, no ADR yet, not started |
| Automated tests | 4 suites; see `docs/COMMANDS.md` §3 |

The previous release, `v0.1`, is kept as history: it made the conversation real (persistence, a
per-turn prompt, an accumulating profile) but held one undifferentiated transcript. `v0.01` (the
"demo") showed the look, before the app had any persistence at all.

---

## Phase 1 — foundations (shipped as v0.1)

**Goal:** make the conversation real. The state lives in a database, the main process owns
it, and replies are built from stored context instead of a single in-page array.

Delivered, each verified against the code rather than the docs:

| Item | Evidence |
| --- | --- |
| SQLite store via the built-in `node:sqlite` (ADR-002) | `app/store.js`; schema and FTS5 tests pass |
| Schema migrations, loud refusal to open a newer database (ADR-004) | a fresh DB reaches the current schema version (v3 since Phase 2; it was v2 when Phase 1 shipped); `db=999` is refused |
| Stable, sortable, UTC IDs (ADR-005) | same-millisecond ordering is deterministic; zero-padding holds across digit boundaries |
| Main process owns turns; renderer only draws (ADR-001) | the renderer no longer assembles a prompt; a test asserts it |
| Per-turn prompt assembly from the store (ADR-008) | system → capabilities → profile → last 30 messages |
| Accumulating profile | turns spoken, first meeting, last seen; injected from turn 2 |
| Full-text index with CJK unigram tokenisation | search works for two-character Chinese words; no UI yet (that is Phase 2) |
| Persona honest about its own limits (ADR-009, revised three times) | the prompt is a short positive list and claims nothing about completeness; the absences are data in `app/capabilities.js` deliberately left unrendered, and a test fails if any of it reaches the prompt |
| The invariants that must not regress | font-weight override, fade mask on `#out`, unconditional `pinBottom()`, one line per reply |

Three packaging defects were found during this phase. The first shipped; the other two were
caught before publishing, which is the point of the checks:

1. `build.files` was never updated when the main process gained `conversation.js`,
   `personality.js` and `store.js`. This one reached users: the `v0.1` exe built from that tree
   died on startup with `MODULE_NOT_FOUND`. A check now walks the actual `require()` graph
   inside the asar.
2. The font in `app/fonts/` was embedded in every build, including published ones, while the
   docs claimed no fonts were redistributed. `release.ps1` now builds with `HDD_NO_FONTS=1` and
   fails if font bytes are found (ADR-011).
3. The same mistake as (1) happened again while adding `app/capabilities.js` — and the check
   stopped it: `capabilities.js is not packaged (required by conversation.js)`, before any
   push. A guard written after a real incident, firing on the next real incident of its own
   kind, is the only evidence that it was worth writing.

Two bugs in `release.ps1` itself surfaced while re-cutting `v0.1` at the same version, both
previously unreachable: `Set-JsonVersion` reported a legitimate no-op as "could not update
version", and step 4's message contained `$Version?`, which PowerShell parses as a variable
named `Version?` and strict mode turns into a fatal error — reachable only when a release has
nothing to commit, which aborted a run *after* the build and verification had passed. Re-cutting
a version is now a supported path.

---

## Phase 2 — topics (shipped as v0.2)

**Goal:** the conversation stops being one undifferentiated transcript. Subjects are
recognised as they happen, they can be switched between and searched, and switching changes
what she is reminded of.

Every item below was verified against the code, the same way Phase 1's were. The decisions
behind them are ADR-012 (with the schema shape from ADR-006).

| Item | Evidence |
| --- | --- |
| `topics` table, nullable `messages.topic_id`, index — migration **3**, additive | `store.test.cjs` §11; a fresh database reports schema v4 |
| `topics.title_locked` — migration **4**, for provisional titles | `store.test.cjs` §13; a fresh database reports schema v4 |
| The v0.1 store upgrades without a rewrite | `store.test.cjs` §12 builds a **v2** database from the shipped migration SQL, and asserts one topic is created, titled from the earliest user message and locked, with every old row in it and no `topic_id` left NULL |
| The backfill is idempotent | reopening that upgraded store still reports exactly one topic |
| **The local rule proposes; the model decides** (ADR-012 revision 1) | `proposeBoundary` returns `propose` + `first`/`idle`/`shift`/`continue`; `main.js` supplies `confirmBoundary`; §10 shows a boundary opening only after a "yes" |
| Nothing can confirm → nothing splits, silently | §10b: no confirmer, a confirmer that throws, and one that returns null all keep the message in place, and all leave the turn usable |
| The local rule is tuned for recall, and the cheap path still works | §9 — interjections and on-topic messages spend no request; zero-overlap messages with substance always do |
| CJK bigrams for the similarity signal, not the FTS single characters | `contentTerms`; the index keeps single characters for a different reason (ADR-002) |
| Topics select context; the profile stays global | §10: a new topic's `historyBefore` does not contain the previous topic's messages |
| Switching changes what is drawn *and* what is sent | §10 covers the transcript; `renderer.test.cjs` asserts the switch replaces the transcript instead of appending |
| Titles: the model names a new topic; a derived title is only the fallback | §10 asserts the confirmed topic carries the confirmer's name, not the truncated sentence |
| A greeting does not become a permanent name, or a leftover topic | §10c and §11: a provisional title is replaced by the first message substantial enough to name a subject, and the greeting topic is absorbed into the subject that follows |
| Manual override (`/new`, `/switch`) | §10 asserts a manually created empty topic is never abandoned by the proposer |
| A real conversation is the evaluation set, and it is replayed | `docs/eval/topics-2026-09-14.json` + §12: the recorded human judgement drives the confirmer, and the replay asserts proposals, layout and per-turn history |
| Search UI over FTS5, cross-topic with the topic title on each hit | `/search` in `renderer.test.cjs`; `store.test.cjs` §11 scopes it to one topic |
| The command surface adds **no** CSS and no new `.line` class | `renderer.test.cjs` compares the `.line.*` classes before and after the command tests |
| The preload ↔ main channel contract cannot drift silently | `renderer.test.cjs` cross-checks every channel `preload.cjs` uses against `main.js`, and every `api.*` the page calls against the preload surface — shown to fail by renaming a channel. Without it, the fake API used by those tests would hide a typo until a command silently did nothing in a real window |
| The invariants that must not regress | mask, `pinBottom()` and the font-weight override are the same assertions as before, unchanged |

What Phase 2 deliberately did **not** do: semantic search. ADR-007 keeps Phase 2 on FTS5 and
leaves embeddings to Phase 5, so "semantic search" stays an open item by decision rather than
by omission.

Two defects were found while building the first version of it, both before any release, both
recorded in ADR-012: an explicitly created empty topic was immediately abandoned by the rules
(so `/new` could never work with a long message), and the boundary decision and the message
timestamps read the clock separately (which made the idle rule silently never fire under an
injected clock). A third was found by the tests while adding the confirmation step: any message
could retitle a topic, so a two-term laugh named one "哈哈哈" and locked it.

**Released as `v0.2` on 2026-09-14.** The artifact passed all four packaging checks — no real API
key inside, every module the app `require`s present in the asar (including `topics.js`, which
would have died on startup if it were missing), no font bytes, and the three interface rules
(mask, `pinBottom()`, font-weight override) still present. The published binary is the one those
checks ran against: it was built once and not rebuilt at publish time.

---

## The remaining phases

Each row lists what the ADRs already commit to. Nothing here is scheduled by date; the
order is the plan.

| Phase | Version | Status | Scope (per ADR) | New tables (ADR-004) |
| --- | --- | --- | --- | --- |
| 2 | v0.2 | **shipped** 2026-09-14 | Topic detection, creation and switching; full-text search UI; the "semantic search" item needs the Phase 5 decision; the behaviour evaluation set starts being collected (ADR-010) | `topics`; `messages.topic_id` nullable, then backfilled (ADR-006) |
| 3 | v0.3 | **shipped** 2026-09-15 | Long-term memory: structured, updatable memories linked to the messages they came from | `memories` |
| 4 | v0.4 | **next — no ADR yet** | Context assembly and projects; topics linked to projects | `projects`, context tables |
| 5 | v0.5 | not started | Files and chunks; chunking, embeddings, semantic retrieval (the vector-store decision is due at the start of this phase — ADR-007) | `files`, `chunks` |
| 6 | v0.6 | not started | Tools: a real capability inventory and a permission model before any tool exists; tool calls linked to turns | `tool_invocations` |
| 7 | v0.7 | not started | Tasks and reminders, calendar as a real capability | `tasks`, `reminders` |
| 8 | v0.8 | not started | Multi-step execution; agent runs linked to turns | `agent_runs` |
| 9 | v0.9 | not started | Schedules and scheduled tasks, weekly reports, export / merge / re-import | `schedules` |
| — | v1.0 | not started | **The full character returns**: cold humour, vanity, teasing, style examples. Deliberately withheld until the capabilities it describes exist (ADR-008). Also the point where the deferred decisions should be settled | |

Older phases stay open for revision: Phase 2's topic model was built before there were real
conversations to build it on, so expect the shape of it to change now that there are some. The
constants in `app/topics.js` are the part most likely to move — see the debts below.

---

## Phase 3 — long-term memory (shipped as v0.3)

**Goal:** she remembers things about the owner across sessions, on purpose rather than by luck.
Memories are structured and updatable, and **every one is linked to the messages it came from**,
so a wrong memory can be traced back to what produced it.

Four ADRs already fixed most of the shape, so none of it was open for debate:

| Already decided | Where |
| --- | --- |
| Same SQLite database — "structured, updatable memories" is the reason SQLite was chosen over JSON | ADR-002 |
| Migration **5**, appended, never editing a shipped one | ADR-004 |
| Stable application-generated ids, UTC epoch milliseconds, links to source messages are foreign keys | ADR-005 |
| The main process owns them; the renderer only asks for what to draw | ADR-001 |
| **No retrieval layer yet** — "Recent-N plus a profile covers Phase 1–3" | ADR-007 deferred table |
| Watch the prompt budget as memory joins it | ADR-008 |

Delivered so far, each verified against the code rather than these notes. The three decisions the
phase had to take are recorded in **ADR-013**.

| Item | Evidence |
| --- | --- |
| `memories` and `memory_sources` — migration **5**, additive | `store.test.cjs` §14; a fresh database reports schema v5 |
| No "active" column: a memory is active exactly while nothing superseded it | `superseded_by IS NULL` is the status, with a partial index for the query the prompt runs |
| A correction supersedes rather than overwrites, and the old row stays readable | §14: the superseded row keeps its text and gains a `superseded_by`/`superseded_at` pair, which a `CHECK` forces to agree |
| `/forget` removes the whole chain, oldest first, so nothing is resurrected | §14 covers the middle-row case too; the self-reference makes the database refuse a half-deletion rather than leave a predecessor reading as active |
| Provenance is enforced, not hoped for | §14: a source id that names no message is refused by the foreign key, and the transaction rolls back so no half-memory is left |
| The local rule decides **when** to ask; the model decides **what** to remember | `app/memory.js`; §13 pins the cue, the cooldown and the correction that cuts through it |
| The cue is first-person reference, not a list of phrasings | §13: the earlier draft missed 我在做 HDD 这个终端项目 |
| A request inside 帮我…/给我… is an object, not a fact | §13; three of the four wrong firings on the first probe of the module were that shape |
| Every failure remembers nothing | §15: no extractor, an unreadable answer, a thrown request, an invented id |
| The reply is never delayed by the extraction | §15, and `main.js` emits `done` before asking |
| Active memories render beside the profile, bounded twice | §16: by count (20) and by characters (1200), newest first |
| Superseded memories stop being injected immediately | §16 |
| `/memories`, `/forget`, `/remember` with no new CSS | `renderer.test.cjs`; the command-surface test still compares the `.line.*` classes before and after |
| The capability declaration gained `memory`, and cannot drift from the machinery | §8 of `conversation.test.cjs`: the check compares the declaration against the **assembled prompt**, not against a function name, and was shown to fail by removing the injection and by renaming the wiring |
| A memory dimension in the evaluation set | `docs/eval/memories-2026-09-14.json`, replayed by §12, which now dispatches on the corpus kind |

The third real conversation already contained the request this phase answers — 「我想给这个软件再
加点本事，让它能记住以前聊过的事情」 — kept in `docs/eval/topics-2026-09-14-run3.json`.

**Released as `v0.3` on 2026-09-15.** Four things were found by a live run before publishing and
fixed and re-verified against the model: names carrying the previous subject over, the first topic
of a store keeping a truncated name, memories keeping a trailing full stop, and — the serious one —
the topic confirmation request being capped at 80 output tokens on a reasoning model, which made
topic splitting silently fail in the shipped v0.2.

**What the memory corpus says about the current cue, measured rather than assumed.** Of the fifteen
real turns, one both should have been asked about and was. Two real facts went unasked — a
preference swallowed by the request frame, and an identity fact stated without a first-person
pronoun — and one turn spent a request on nothing. Those three disagreements are recorded as
assertions in the corpus, so improving the cue forces that file to be updated instead of leaving a
silent improvement behind.

---

## Open decisions and known debts

Not blockers, but they should not be forgotten.

1. **Settled in `0.1.0`: how she talks about her own limits.** Three rounds of revision. First
   the capability facts left `app/personality.js` for `app/capabilities.js` — a local edit had
   deleted the whole boundary, which revealed a layering mistake rather than a mistake in the
   edit: capability is an environment fact, and a character file meant a tone change could
   silently remove a guarantee. Then a real conversation showed the rendered "cannot" list
   being read back to the user verbatim. Then the replacement's "this is the whole of it"
   sentence produced a closing "就这些". The prompt is now a heading and two bullets, and
   nothing is claimed about completeness (ADR-009, revised three times). Verified by behaviour
   probes through the real assembly path, not only by assertions.
2. **Capability declarations are hand-maintained until Phase 6.** `main.js` sending `tools` is
   cross-checked against the declared `tools` capability, and the page CSP against a declared
   network capability, so neither can drift silently. The remaining absences (`camera`,
   `hardware`, `actions`, `files`) are statements about absence that no test can meaningfully
   verify — they exist so whoever adds a capability sees what was already considered. Phase 6
   should generate the tool entry from the real tool registry.
3. **The packaged data-directory branch is not covered by automation.** `getDataDir()`
   returns `app.getPath('userData')/data` when packaged, and the tests run outside Electron.
   Verified once by launching a built exe (it created `%APPDATA%\HDD\data\hdd.db` at schema
   v2 and reopened cleanly after a kill), but a regression here would only be caught by hand.
4. **`NOTICE` is a verbatim copy of the upstream file** and references a `TRADEMARKS.md`
   that this repository does not contain. Left verbatim deliberately — it is the upstream
   project's notice — but the dangling reference should be resolved when the licensing
   files are next revisited.
5. **Old artifacts pile up in `app/dist/`** (gitignored, so harmless): `HDD-0.01.exe` sits
   beside the current build.
6. **Nothing evaluates reply *quality*.** ADR-010 defers this to a corpus built from real
   Phase 2 conversations. Until then, "the reply was bad" is diagnosed with
   `npm run inspect`, not measured.
7. **The evaluation set exists and has already changed the design twice.** `docs/eval/` holds three
   real conversations with a judgement recorded for every turn — 27 turns — and replaying them is
   what disproved ADR-012 revision 0 (a continuation and a change of subject both scored 0.000
   coverage, so no threshold could have separated them) and found the two turns revision 1 never
   asked about. The entries are data, replayed by `conversation.test.cjs` §12, so adding the next
   case is appending a turn and a judgement rather than writing an assertion. What it does **not**
   cover is reply quality, and three transcripts is still a small sample: it is a start, not a
   corpus.
8. **The confirmer works in both directions, and has been observed doing it.** A real conversation
   produced a topic named 「电影推荐」 — proof the request is made, answered, parsed and used — and
   a later one answered `same` on five proposals, every one of them correctly, including the two
   sentences that broke the original design. What is still unmeasured is its *quality over time*:
   none of the three transcripts was adversarial. Growing `docs/eval` is how that gets settled.
9. **A boundary costs a request, and the reply waits for it.** One extra small call on every
   proposed turn, plus its latency before the first token. Measured across all three transcripts,
   that is most turns where the subject drifts — 10 of 15 turns in the third one. This withdraws
   revision 0's "no extra request" and it is the standing price of ADR-012 revision 1. The levers
   if it proves annoying are `PROPOSE_COVERAGE` and `MIN_SHARED_TERMS`: both raise the bar for
   asking, and both make silent misses more likely.
10. **Memory adds a second request, and the trigger is what keeps it rare.** The extraction runs
    after the reply is on screen, so it delays nothing the user waits for — but it is a real
    request. On the fifteen real turns of the memory corpus it was spent twice: once on a fact
    worth keeping, once on nothing. The levers are `COOLDOWN_TURNS`, `MIN_SELF_TERMS` and the
    request-frame list in `app/memory.js`.
11. **The memory cue misses facts, and the misses are recorded rather than accepted.** Two of the
    fifteen real turns held a fact that should have been remembered and was not asked about: a
    preference stated inside a request ("最好是硬科幻那种"), and an identity fact with no
    first-person pronoun ("上学好烦啊"). Loosening the cue would catch them and would spend a
    request on every turn shaped like 帮我…, which is the most common shape there is. The trade is
    measured in `docs/eval/memories-2026-09-14.json` and asserted by the tests, so changing it
    cannot happen silently. **This is the first thing the next real conversation should be judged
    against.**
12. **The local constants are still guesses**, now twice corrected by real transcripts rather than
    by reasoning, and tuned for recall: `MIN_PROPOSAL_TERMS` 3, `MIN_SHARED_TERMS` 2,
    `PROPOSE_COVERAGE` 0.15, `IDLE_COVERAGE` 0.35, `IDLE_GAP_MS` 6 h, plus memory's
    `COOLDOWN_TURNS` 4. Three transcripts in `docs/eval` are the whole of the evidence behind them.
13. **The command surface has almost never been driven by hand.** Electron cannot start in the
    environment this was developed in, so `/topics`, `/switch`, `/new`, `/rename`, `/search`,
    `/memories`, `/forget`, `/remember` and `/help` are covered by jsdom and by a static
    cross-check that every IPC channel the preload uses exists in the main process — not by a
    person clicking. `/memories` has been run by hand once, in v0.2's development; `/forget` and
    `/remember` have not been run by hand at all. `main.js`'s handlers have never been exercised
    outside a real launch. Launching `HDD-0.3.0.exe` once and typing them closes this, and would
    verify the packaged data-directory branch in debt 3 at the same time.
14. **`inspect.cjs` reports the packaged data-directory branch the same way it always did**, but
    the two new flags (`--topic`) are untested by automation: like the packaged path in debt 3,
    they are verified by running them once. `--topic` was checked against a two-topic scratch
    store, including that `--prompt` then describes only the topic in progress. **It also does not
    show memories yet**, which is now the audit gap it exists to close: `--prompt` prints what the
    next turn would send, and that includes the memory section, but nothing prints what is stored.
15. **Phase scope lives in this repository, or it cannot be checked.** Every phase's scope is
    defined by the ADRs here, and the code is cross-checked against them — which works only for
    requirements that are written down here. A requirement that exists only outside this
    repository cannot be verified against the build, and will surface as a surprise after a
    release rather than as a failing test before one. Anything the project is expected to satisfy
    belongs in `docs/`.
16. **The confirmer over-splits, measured once.** With the classifier model, replaying the third
    real conversation gave 7 of 10 agreement with the recorded judgement, 0 failures, ~1.2s
    median — and **every** disagreement was same→new, never the other way. The three were a
    greeting followed by the first real statement (where the model's answer is arguably better,
    since a new topic gets a model-generated name) and two short capability questions that a
    person reads as one subject. One conversation is not enough to change a prompt on, so it is
    recorded in `docs/eval/topics-2026-09-14-run3.json` under `liveMeasurement` until there is
    more of it.
17. **Two facts about the same thing in one answer — the guard is in, the behaviour persists.** A
    live run on one turn produced 「主人在做 HDD 终端项目」 *and* 「主人的 HDD 终端项目使用内置的
    node:sqlite 作为数据库」. The prompt now forbids entries that contain each other, and a second
    live run produced the same pair: not because the instruction was ignored, but because these two
    are **not** containment — one states the project exists, the other states its database, and the
    second only *implies* the first. Whether that is worth a stronger rule (one fact per entity per
    answer, or one per turn) is a real question, and both cost recall, so it stays where the
    evidence is: harmless and slightly repetitive, both true, both visible in `/memories`.
18. **The confirmer over-splits short follow-ups, now seen twice.** Replaying the third real
    conversation live gave the same three same→new disagreements both times — the three short
    capability questions became three topics (「助手能力介绍」「表情识别请求」「对话保存为文件」)
    where the recorded judgement keeps one. Two independent runs pointing the same way is stronger
    evidence than one, but it is still one conversation, so the prompt is unchanged until there is
    more of it.
19. **Two cosmetic naming gaps, one now fixed.** The first topic of a store used to keep a truncated
    sentence as its title, because a substantive first message locked the derived name — and the
    model is only asked when a boundary is proposed, so it could never replace it. A derived title is
    now always provisional: the same live run titled that topic 「HDD 终端项目数据库」. What remains
    is a topic in which no boundary is ever proposed: it keeps the derived name, which is at least
    on-topic because the conversation never left the subject. The other gap — a new topic's name
    carrying the previous subject over (「今天天气不错」 became 「杭州天气闲聊」) — is fixed by an
    explicit instruction and was verified gone in the next run.

---

## Verifying the current state

```powershell
cd D:\Coding\HDD
npm test                                   # the gate: bake + all four suites
npm run app:start                          # in the running app: /topics, /search, /help
.\release.ps1 -Version 0.3.0 -DryRun       # what the next release would do
```

Re-verifying a published artifact without rebuilding it:

```powershell
cd D:\Coding\HDD
.\release.ps1 -Version 0.2.0 -VerifyOnly   # re-runs the asar checks on app\dist
```

`docs/COMMANDS.md` lists every command with the directory it must run from.
