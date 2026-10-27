# Starting the next session

A handover note, rewritten after Phase 4 was implemented on 2026-10-27. It exists so a new session
can start from the truth instead of from the previous session's narration.

**`docs/ROADMAP.md` is the authority on progress; this file is the briefing.** When the two
disagree, the roadmap (and the code) win — and this file should be updated or deleted rather than
left to rot. Everything below was true at the moment it was written.

---

## Where the project is

- **v0.3 shipped** (`0.3.0`, pre-release, tag `v0.3`) — Phase 3, long-term memory.
- **Phase 4 is implemented, not released.** ADR-014 decided it, migration 6 is in, and the store,
  prompt, command and renderer layers are covered by tests — but it has never been through a real
  window, a release build, or a real conversation. That gap is the whole of what is left.
- Schema is at **v6**; `npm test` (root) reports **611 assertions across four suites**.
- The tree is ahead of `origin/main` by the Phase 4 commits; nothing has been pushed.

## How to work here

- Conversation in Chinese; **code comments in English**, and only where they earn their place.
- Local commits freely. **Ask before pushing.** Same for anything that publishes.
- `npm test` from the repository root is the gate: asset bake plus four suites, all green.
- **When docs and code disagree, the code is right** — then fix the docs. Any constant or number
  written into documentation must be read out of the code or measured first.
- Do not change a verified visual effect without saying so first (the mask, `pinBottom()`, the
  font-weight override).
- **Do not set a threshold by reasoning.** Twice in this project a confidently-reasoned threshold
  was disproved by one real conversation. `docs/eval/` is the authority, and adding a case there is
  adding data rather than editing an assertion.
- **A new check must be shown to fail** before it is committed. The IPC contract check, the
  capability cross-check and the packaging check were each demonstrated failing.
- Ask questions in prose with lettered options rather than in a modal.

## Environment

- **The checkout moved on 2026-10-09**: the project is now at `D:\DSH_Workspace\01_Code\HDD`, and was
  at `D:\Coding\HDD` before that. Everything the project needs lives under `HDD\` — the workspace root
  holds no other folder — including the font diagnostics in `.hdd-font/`, a small npm project of its
  own that git ignores. `docs/COMMANDS.md`, `docs/ROADMAP.md` and those scripts were updated to the
  new paths, and the scripts now resolve the font directory from their own location rather than from
  a hard-coded one.
- **A tree copied in from outside this workspace cannot be written under `workspace-write`.** The
  copied files keep the integrity label they had at the old location, so the sandbox's low-integrity
  process is refused by the operating system while the permissions look perfectly correct: `npm test`
  dies with `EPERM` in the asset bake, and none of the usual permission repairs help. This cost `HDD/`
  the days between 2026-10-09 and 2026-10-12; the fix was write-owner rights plus one
  `icacls "…\HDD" /setintegritylevel "(OI)(CI)Low" /T`, applied to the diagnostics folder too.
  Suspect it whenever a denial contradicts what the active policy promises.
- `npm run dev`, `npm run inspect`, `npm run probe` live in `app/`; `npm test` lives at the root.
  The two `package.json` files do not offer the same scripts.
- `electron-builder` builds, `git push` and `gh` are denied in the sandbox (`spawn EPERM`,
  `schannel`) and need escalation.
- **Electron cannot start in the sandbox**, so anything requiring a real window — or a packaged
  build — has to be run by the owner. Say so plainly instead of implying it was verified.
- In `pwsh`, .NET file APIs (`[System.IO.File]::…`) need **absolute** paths: a relative one resolves
  against the process working directory, not against `cd`. This has cost real time here.
- Do not truncate a long-running command's output with `Select-Object -First N` — it kills the
  process part-way through.

## The testing tool built in v0.3

- **The sandbox can reach `api.deepseek.com`** (measured: HTTP 401 in 159 ms). Requests that need
  the network can therefore be run here rather than relayed through the owner.
- `cd app; npm run probe` — no window, no Electron. It drives the real `conversation.js` and
  `api.js` against the real API in a scratch store and writes everything to
  `app/data/probe/<timestamp>/`: every prompt sent, every raw answer, what was made of it, what was
  stored with its provenance, and how long each call took. **The report is inside the workspace, so
  it can be read directly.**
- `npm run probe -- --corpus docs/eval/<file>.json` — replays a recorded conversation, asks the real
  model every turn the local rule proposes, and compares its verdicts with the judgement recorded
  for each turn. This is the only way to score the *model* rather than the machinery.
- `npm run probe -- --dry-run` — prints the prompts that would be sent and sends nothing.
- **Ask before spending API credit**, and say roughly how many calls it will be. The owner is
  generous with it but wants to know where it goes.
- `app/config.json` holds a real key (35 characters). Never print it, never commit it, never package
  it. `release.ps1` swaps in the placeholder and verifies the artifact contains no key.

## Decisions that must not be quietly undone

- **The local rule proposes; the model decides.** Both the topic boundary and the memory extraction
  work this way. Every failure — no key, timeout, unreadable answer, thrown error — means "do
  nothing", never a default that would let an unreachable model invent a topic or a fact.
- **The dangerous failure mode is silent degradation.** v0.2 shipped with the boundary request
  capped at 80 output tokens on a *reasoning* model: the budget went to thinking, the answer never
  arrived, and because null reads as "stay in the current topic", topic splitting looked like it
  worked while mostly not happening. Look for that shape in new code.
- **Side requests use a non-reasoning model** (`deepseek-chat` by default; `classifierModel` in
  config or `DEEPSEEK_CLASSIFIER_MODEL`). The reply uses `model`.
- **Memories supersede, never overwrite**; `/forget` genuinely deletes, and deletes the whole
  supersession chain, because an owner asking for something to be gone is not the same as the app
  correcting itself. Memories are global; topics are local.
- **`api.js` exists because `main.js` cannot be loaded outside Electron** — anything left there can
  never be tested. Keep the two side requests there.
- **`build.files` is hand-maintained and has been forgotten three times.** A test now walks the
  require graph in seconds; if you add a module, that test tells you.
- `docs/eval/` entries are data: adding a case is appending a turn and its judgement.
- **A project is a container the owner fills, never one the app infers.** No inheritance on a
  boundary, no keyword rule, no model guess. The cost — one `/project <n>` per new topic — is
  stated in ADR-014, and a real workload is the only thing that can judge it.
- **The project block is reference, not history, and it is derived.** Its rows are read at assembly
  time; there is no context table and no generated project summary. The current topic is excluded,
  and the section is labelled so it cannot be read as something said in the current exchange.

## Debts waiting, measured rather than suspected

The full list is at the end of `docs/ROADMAP.md`. The ones most likely to matter next:

- **`inspect.cjs` still has no listing for stored memories or projects.** `--prompt` now uses the
  real assembler, so both sections appear with their caps applied; what is missing is a way to see a
  memory that lost the cap, or a project no current topic points at.
- **The project block's effect is unmeasured.** The machine side is asserted; whether she uses the
  project's other topics, or misreads an excerpt as something said just now, needs a real
  conversation. It is the phase's main risk.
- **The project curation cost is unmeasured.** One `/project <n>` per new topic, and no inheritance.
  If that is what stops projects being used, automatic assignment comes back with evidence.
- **Nothing can rename or delete a project.** A typo stays in `/projects`; deletion needs a
  confirmation design the command surface does not have.
- **The topic confirmer over-splits short follow-ups** — seen twice, always in the same direction
  (same→new). Three short capability questions became three topics where a person would keep one.
- **The extraction cue misses some real facts** — a preference stated inside a request, and an
  identity fact with no first-person pronoun. Two of fifteen turns in the recorded conversation.
  Widening the cue would spend a request on nearly every turn shaped like `帮我…`.
- **The thresholds in `topics.js` and `memory.js` are still estimates**, with three conversations as
  the whole of the evidence.
- **The packaged data-directory branch and the command surface are not covered by automation.** One
  launch of the built exe closes both: it should create `%APPDATA%\HDD\data\hdd.db` at schema v6,
  and the commands can be typed there (`/memories` is the only one ever driven by hand).
