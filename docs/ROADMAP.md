# HDD — roadmap and progress

The nine phases below are assembled from what `docs/ADR.md` says about each one (the ADRs
are authoritative; this file only collects them in one place and records how far along we
are). Each phase ends in a released version, so "Phase 2" and "v0.2" are the same target.

---

## Where we are

| | |
| --- | --- |
| Current release | **v0.1** (`0.1.0`), pre-release, tag `v0.1` |
| Released | 2026-09-10 |
| Artifact | `HDD-0.1.0.exe` (95.5 MB, portable, Windows x64) |
| Release page | https://github.com/KarinnKyou/Fairy/releases/tag/v0.1 |
| Phase in progress | **Phase 2 — topics**, implemented in the working tree, **not yet released** |
| Automated tests | 4 suites; see `docs/COMMANDS.md` §3 |

The previous release, `v0.01` (the "demo"), is kept as history: it showed the look, but
before Phase 1 the app had no persistence and no real conversation state.

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

## Phase 2 — topics (in the tree, not yet released)

**Goal:** the conversation stops being one undifferentiated transcript. Subjects are
recognised as they happen, they can be switched between and searched, and switching changes
what she is reminded of.

Every item below was verified against the code, the same way Phase 1's were. The decisions
behind them are ADR-012 (with the schema shape from ADR-006).

| Item | Evidence |
| --- | --- |
| `topics` table, nullable `messages.topic_id`, index — migration **3**, additive | `store.test.cjs` §11; a fresh database reports schema v3 |
| The v0.1 store upgrades without a rewrite | `store.test.cjs` §12 builds a **v2** database from the shipped migration SQL, and asserts one topic is created, titled from the earliest user message, with every old row in it and no `topic_id` left NULL |
| The backfill is idempotent | reopening that upgraded store still reports exactly one topic |
| Boundaries decided locally — no extra request, no model call | `app/topics.js`; `decideBoundary` returns `first`/`idle`/`shift`/`continue` |
| CJK bigrams for the similarity signal, not the FTS single characters | `contentTerms`; the index keeps single characters for a different reason (ADR-002) |
| Constants measured against labelled exchanges, not guessed | `conversation.test.cjs` §9 — 8 continuations, 5 changes of subject, the idle band, truncation |
| Topics select context; the profile stays global | §10: a new topic's `historyBefore` does not contain the previous topic's messages |
| Switching changes what is drawn *and* what is sent | §10 covers the transcript; `renderer.test.cjs` asserts the switch replaces the transcript instead of appending |
| Titles derived, truncated at 24 characters, renamable | §9; `/rename` in `renderer.test.cjs` |
| Manual override (`/new`, `/switch`) | §10 asserts a manually created empty topic is never abandoned by the detector |
| Search UI over FTS5, cross-topic with the topic title on each hit | `/search` in `renderer.test.cjs`; `store.test.cjs` §11 scopes it to one topic |
| The command surface adds **no** CSS and no new `.line` class | `renderer.test.cjs` compares the `.line.*` classes before and after the command tests |
| The preload ↔ main channel contract cannot drift silently | `renderer.test.cjs` cross-checks every channel `preload.cjs` uses against `main.js`, and every `api.*` the page calls against the preload surface — shown to fail by renaming a channel. Without it, the fake API used by those tests would hide a typo until a command silently did nothing in a real window |
| The invariants that must not regress | mask, `pinBottom()` and the font-weight override are the same assertions as before, unchanged |

What Phase 2 deliberately did **not** do: semantic search. ADR-007 keeps Phase 2 on FTS5 and
leaves embeddings to Phase 5, so "semantic search" stays an open item by decision rather than
by omission.

Two defects were found while building it, both before any release, both recorded in ADR-012: an
explicitly created empty topic was immediately abandoned by the detector (so `/new` could never
work with a long message), and the boundary decision and the message timestamps read the clock
separately (which made the idle rule silently never fire under an injected clock).

---

## The remaining phases

Each row lists what the ADRs already commit to. Nothing here is scheduled by date; the
order is the plan.

| Phase | Version | Status | Scope (per ADR) | New tables (ADR-004) |
| --- | --- | --- | --- | --- |
| 2 | v0.2 | **in tree, unreleased** | Topic detection, creation and switching; full-text search UI; the "semantic search" item needs the Phase 5 decision; the behaviour evaluation set starts being collected (ADR-010) | `topics`; `messages.topic_id` nullable, then backfilled (ADR-006) |
| 3 | v0.3 | not started | Long-term memory: structured, updatable memories linked to the messages they came from | `memories` |
| 4 | v0.4 | not started | Context assembly and projects; topics linked to projects | `projects`, context tables |
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
7. **Phase 2's boundaries were tuned on constructed exchanges, not real ones.** ADR-010 wanted
   the evaluation set to *start being collected* here, and it exists — `conversation.test.cjs`
   §9 holds 8 continuations, 5 changes of subject and the idle band — but every case was written
   to represent a shape of conversation, not copied from one. The constants in `app/topics.js`
   (`MIN_TERMS_TO_JUDGE` 8, `SHIFT_COVERAGE` 0.05, `IDLE_COVERAGE` 0.2, `IDLE_GAP_MS` 6 h) are
   the first things to re-measure once real transcripts exist: they were tuned to remove every
   observed *false split*, which is the expensive mistake (she loses the subject), at the known
   cost of merging short genuinely-new subjects into the current topic.
8. **Topic detection cannot see paraphrase, and that is structural.** A subject continued in
   entirely different words scores near-zero lexical overlap and reads as a change of subject.
   `/new` and `/switch` are the escape hatch, and embeddings are the real fix — the same Phase 5
   decision ADR-007 defers. Revisit the two together.
9. **v0.2 is not released.** The code is in the tree and the gate is green, but no artifact has
   been built, nothing is committed, and nothing is pushed. `release.ps1` needs the sandbox
   escalation for `electron-builder` and for `git push`/`gh`, and pushing is a decision for the
   owner of the repository rather than a step to take automatically.
10. **`inspect.cjs` reports the packaged data-directory branch the same way it always did**, but
    the two new flags (`--topic`) are untested by automation: like the packaged path in debt 3,
    they are verified by running them once. `--topic` was checked against a two-topic scratch
    store, including that `--prompt` then describes only the topic in progress.

---

## Verifying the current state

```powershell
cd D:\Coding\HDD
npm test                                   # the gate: bake + all four suites
npm run app:start                          # in the running app: /topics, /search, /help
.\release.ps1 -Version 0.2.0 -DryRun       # what the next release would do
```

`docs/COMMANDS.md` lists every command with the directory it must run from.
