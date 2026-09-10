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
| Phase in progress | **Phase 2 — topics** (not started) |
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
| Schema migrations, loud refusal to open a newer database (ADR-004) | fresh DB reaches v2; `db=999` is refused |
| Stable, sortable, UTC IDs (ADR-005) | same-millisecond ordering is deterministic; zero-padding holds across digit boundaries |
| Main process owns turns; renderer only draws (ADR-001) | the renderer no longer assembles a prompt; a test asserts it |
| Per-turn prompt assembly from the store (ADR-008) | system → capabilities → profile → last 30 messages |
| Accumulating profile | turns spoken, first meeting, last seen; injected from turn 2 |
| Full-text index with CJK unigram tokenisation | search works for two-character Chinese words; no UI yet (that is Phase 2) |
| Persona honest about its own limits (ADR-009, revised three times) | the prompt is a short positive list and claims nothing about completeness; the absences are data in `app/capabilities.js` deliberately left unrendered, and a test fails if any of it reaches the prompt |
| The invariants that must not regress | font-weight override, fade mask on `#out`, unconditional `pinBottom()`, one line per reply |

Two defects found while auditing this phase, both of which would have shipped a broken
release, and both now covered by checks in `release.ps1`:

1. `build.files` was never updated when the main process gained `conversation.js`,
   `personality.js` and `store.js`. The packaged exe died on startup with
   `MODULE_NOT_FOUND`. A check now walks the actual `require()` graph inside the asar.
2. The font in `app/fonts/` was embedded in every build, including published ones, while
   the docs claimed no fonts were redistributed. `release.ps1` now builds with
   `HDD_NO_FONTS=1` and fails if font bytes are found (ADR-011).

---

## The remaining phases

Each row lists what the ADRs already commit to. Nothing here is scheduled by date; the
order is the plan.

| Phase | Version | Scope (per ADR) | New tables (ADR-004) |
| --- | --- | --- | --- |
| 2 | v0.2 | Topic detection, creation and switching; full-text search UI; the "semantic search" item needs the Phase 5 decision; the behaviour evaluation set starts being collected (ADR-010) | `topics`; `messages.topic_id` nullable, then backfilled (ADR-006) |
| 3 | v0.3 | Long-term memory: structured, updatable memories linked to the messages they came from | `memories` |
| 4 | v0.4 | Context assembly and projects; topics linked to projects | `projects`, context tables |
| 5 | v0.5 | Files and chunks; chunking, embeddings, semantic retrieval (the vector-store decision is due at the start of this phase — ADR-007) | `files`, `chunks` |
| 6 | v0.6 | Tools: a real capability inventory and a permission model before any tool exists; tool calls linked to turns | `tool_invocations` |
| 7 | v0.7 | Tasks and reminders, calendar as a real capability | `tasks`, `reminders` |
| 8 | v0.8 | Multi-step execution; agent runs linked to turns | `agent_runs` |
| 9 | v0.9 | Schedules and scheduled tasks, weekly reports, export / merge / re-import | `schedules` |
| — | v1.0 | **The full character returns**: cold humour, vanity, teasing, style examples. Deliberately withheld until the capabilities it describes exist (ADR-008). Also the point where the deferred decisions should be settled |

Older phases stay open for revision: Phase 2's topic model will be built on real
conversations, so expect the shape of it to change once there are some.

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

---

## Verifying the current state

```powershell
cd D:\Coding\HDD
npm test                                   # the gate: bake + all four suites
.\release.ps1 -Version 0.2.0 -DryRun       # what the next release would do
```

`docs/COMMANDS.md` lists every command with the directory it must run from.
