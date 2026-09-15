# Starting the next session

A handover note, written after `v0.3` was released on 2026-09-15. It exists so a new session can
start from the truth instead of from the previous session's narration.

**`docs/ROADMAP.md` is the authority on progress; this file is the briefing.** When the two
disagree, the roadmap (and the code) win — and this file should be updated or deleted rather than
left to rot. Everything below was true at the moment it was written.

---

## Where the project is

- **v0.3 shipped** (`0.3.0`, pre-release, tag `v0.3`) — Phase 3, long-term memory.
- **Next: Phase 4** — "Context assembly and projects; topics linked to projects", new tables
  `projects` and context tables (migration 6).
- **Phase 4 has no ADR yet.** Phase 3 had ADR-013. So the first real step is to read what
  ADR-001/004/006/007/008 already commit to, then write the ADR that settles the rest — before any
  code depends on it.
- Schema is at **v5**; `npm test` (root) reports **548 assertions across four suites**.
- The tree may be one commit ahead of `origin/main` (the roadmap's release bookkeeping).

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

## Debts waiting, measured rather than suspected

The full list is at the end of `docs/ROADMAP.md`. The ones most likely to matter next:

- **`inspect.cjs` still cannot show stored memories**, even though it prints a prompt that contains
  them. This is the audit tool's one remaining blind spot.
- **The topic confirmer over-splits short follow-ups** — seen twice, always in the same direction
  (same→new). Three short capability questions became three topics where a person would keep one.
- **The extraction cue misses some real facts** — a preference stated inside a request, and an
  identity fact with no first-person pronoun. Two of fifteen turns in the recorded conversation.
  Widening the cue would spend a request on nearly every turn shaped like `帮我…`.
- **The thresholds in `topics.js` and `memory.js` are still estimates**, with three conversations as
  the whole of the evidence.
- **The packaged data-directory branch and the command surface are not covered by automation.** One
  launch of the built exe closes both: it should create `%APPDATA%\HDD\data\hdd.db` at schema v5,
  and the commands can be typed there (`/memories` is the only one ever driven by hand).
