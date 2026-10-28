# Starting the next session

A handover note, rewritten on 2026-10-28 after the product boundary was decided (ADR-015) and
Phase 5 was reshaped (ADR-016). It exists so a new session can start from the truth instead of from
the previous session's narration.

**`docs/ROADMAP.md` is the authority on progress; this file is the briefing.** When the two
disagree, the roadmap (and the code) win — and this file should be updated or deleted rather than
left to rot. Everything below was true at the moment it was written.

---

## Where the project is

- **v0.4 shipped** (`0.4.0`, pre-release, tag `v0.4`) — Phase 4, projects and context assembly.
- **Phase 5 is in progress on paper only.** ADR-015 (the boundary, the two registers, delegation)
  and ADR-016 (the owner's library: Zotero notes and highlights first, text-layer PDFs later) are
  Accepted. **Phase 5 has started:** the Zotero sync, schema v7, the embedding client, `/recall`,
  the measured threshold and the labelled prompt section are in the tree (1386 chunks embedded;
  0.55 keeps 10/11 positives with 0/2 false positives; injection capped at 3 chunks / 1200
  characters). The L1 `/hand` brief is written as a file; `/read` does not exist yet.
- **Schema is v7; `npm test` (root) runs five suites** (`store`, `zotero`, `conversation`,
  `renderer`, `scroll-pin`).
- **ADR-015 removed Phase 8** (agent runs) and narrowed Phase 6: execution is delegated to the
  harness, not rebuilt here.
- The decision record is committed locally (ADR-015/016 and the measurements); the tree is clean.

## The direction, in one paragraph

**HDD is a room, not a printer.** Her subject is the owner's reading, notes, projects and personal
facts — not the owner's codebase. Conversation is a short explanation (2–5 sentences, no lists, no
headings); long content is a follow-up turn, a command's structured output, or a file. Execution
belongs to the harness: HDD may **propose** a handoff, the owner confirms, and the brief is a file,
never something to copy and paste. The boundary test for any feature: if its deliverable is a work
artifact, it belongs in the harness; if it is continuity and conversation, it belongs here.

## How to work here

- Conversation in Chinese; **code comments in English**, and only where they earn their place.
- Local commits freely. **Ask before pushing.** Same for anything that publishes.
- `npm test` from the repository root is the gate: asset bake plus five suites, all green.
- **When docs and code disagree, the code is right** — then fix the docs. Any constant or number
  written into documentation must be read out of the code or measured first.
- Do not change a verified visual effect without saying so first (the mask, `pinBottom()`, the
  font-weight override, the folded newline).
- **Do not set a threshold by reasoning.** Twice in this project a confidently-reasoned threshold
  was disproved by one real conversation. `docs/eval/` is the authority, and adding a case there is
  adding data rather than editing an assertion.
- **A new check must be shown to fail** before it is committed. The IPC contract check, the
  capability cross-check and the packaging check were each demonstrated failing.
- Ask questions in prose with lettered options rather than in a modal.
- **The conversation register is a rule, not a taste.** A long answer is a file or a command's
  output; never a wall of chat text (ADR-015).
- **Delegation is proposed, never inferred.** The model never decides to send a task; the owner
  approves, and every handoff is recorded (ADR-015).
- **A retrieved chunk is labelled original text or the owner's note**, and a note is never
  attributed to the paper (ADR-016).

## Environment

- **The checkout moved on 2026-10-09**: the project is now at `D:\DSH_Workspace\01_Code\HDD`, and was
  at `D:\Coding\HDD` before that. Everything the project needs lives under `HDD\` — the workspace root
  holds no other folder — including the font diagnostics in `.hdd-font/`, a small npm project of its
  own that git ignores. `docs/COMMANDS.md`, `docs/ROADMAP.md` and those scripts were updated to the
  new paths, and the scripts now resolve the font directory from their own location rather than from
  a hard-coded one.
- **The checkout must stay at medium integrity, and that cost a day to learn.** A tree copied from
  another location keeps the integrity label it had there; under a low-integrity sandbox that showed
  up as `EPERM` in the asset bake on 2026-10-09. The 2026-10-12 workaround was to relabel the whole
  tree Low — and on 2026-10-27 that turned out to make **Electron unstartable**: every launch died
  with exit code `2147483651` (`0x80000003`) before a window or the store existed, because Chromium
  refuses to start from a low-labeled executable. The tree is Medium again
  (`icacls "…\HDD" /setintegritylevel "(OI)(CI)Medium" /T /C /Q`), and both the window and
  `npm test` work. **Do not relabel it Low again**; if a write is denied, fix the ACL (write owner),
  not the label.
- `npm run dev`, `npm run inspect`, `npm run probe` live in `app/`; `npm test` lives at the root.
  The two `package.json` files do not offer the same scripts.
- `electron-builder` builds, `git push` and `gh` are denied in the sandbox (`spawn EPERM`,
  `schannel`) and need escalation.
- **Electron starts here again** (smoke-launched 2026-10-27 with `HDD_DATA_DIR` pointed at a scratch
  directory). The automated tests still never open a window, and a packaged build is still the
  owner's step — do not imply either was verified by them.
- In `pwsh`, .NET file APIs (`[System.IO.File]::…`) need **absolute** paths: a relative one resolves
  against the process working directory, not against `cd`. This has cost real time here.
- Do not truncate a long-running command's output with `Select-Object -First N` — it kills the
  process part-way through.

## The harness, measured on 2026-10-28

- `dsh --profile headless "<task>"` exists (CLI at `C:\Users\karin\AppData\Roaming\npm\dsh.cmd`):
  one task in, the final assistant message out, exit. It is the intended one-shot interface.
- **Credentials are the first wall.** Without `DEEPSEEK_API_KEY` exported to the child it fails with
  `MISSING_CREDENTIAL` and names the harness credentials service. The GUI's stored key is not
  reachable from a spawned process; HDD must inject its own key into the child environment only.
- **It ran tools without any approval prompt.** That is why ADR-015 puts a person at the approval
  step and shows the brief before sending.
- **Its shell is broken under this configuration**: first `Windows ACL temp root must be outside the
  workspace` (do not use `%TEMP%` as the workspace), then `spawn C:\Program Files\PowerShell\7\pwsh.exe
  ENOENT` even though that path exists. It reported both failures honestly instead of claiming
  success — but the failure arrived as an ordinary final message, so a caller must read the output,
  not just note that the process finished. L2 must verify the shell, the temp root and the approval
  behaviour before it is trusted.
- HDD's own key (`app/config.json`) is 35 characters; `deepseek-v4-flash` is a working alias for
  `deepseek-flash`. `deepseek-chat` still resolves and still behaves as the non-reasoning model.
- **DeepSeek exposes no embeddings endpoint** (2026-10-28): `GET /models` lists only `deepseek-flash`
  and `deepseek-v4-pro`; `POST /embeddings`, `/v1/embeddings` and `/beta/embeddings` are 404 while
  `/v1/chat/completions` is 200.
- **SiliconFlow's `BAAI/bge-m3` is the first measured embedding candidate** (2026-10-28): 1024
  dimensions, 327 ms, 90 tokens for six short texts. A Chinese→English sanity matrix separated a
  direct match (0.804) from unrelated pairs (0.32–0.40), but a conceptual query's margin was only
  0.032 — rank, do not threshold on one number. The key lives in the user environment as
  `HDD_EMBEDDING_API_KEY` (with `HDD_EMBEDDING_BASE_URL`, `HDD_EMBEDDING_MODEL`), never in the repo.

## Zotero, measured on 2026-10-28

- **The local API works and needs no key.** Zotero 10.0.6 answers at
  `http://127.0.0.1:23119/api/users/0` (200 OK, 620 items, library version 1001, schema 44, user
  library id 20602426). The connector ping also answers, and the API needs no
  `Zotero-Allowed-Request` header.
- **The corpus:** 35 papers (journal articles, conference papers, preprints, reports/documents),
  29 Chinese notes of 11–14k characters, 521 highlights, 35 PDF attachments.
- **The shapes:** a note has `data.note` (HTML with `h2`/`p`/`ul`/`div`) and `data.parentItem` = the
  paper. A highlight has `data.annotationText` (an exact English sentence), `data.annotationComment`
  (the Chinese comment), `data.annotationPageLabel` (`45:15`) and `data.parentItem` = the PDF
  attachment; that attachment's `parentItem` is the paper. Papers carry title, creators, date, tags
  and an ~800-character abstract.
- **Implication:** the importer fetches attachments first to map highlight → attachment → paper;
  notes map directly. The API is read-only and serves no PDF text, so full paper text still needs
  PDF parsing.
- **Privacy:** syncing is local, but embedding sends chunk text to SiliconFlow. Nothing is embedded
  until the owner has explicitly accepted that.

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
- **`probe --retrieval` does not exist yet.** ADR-016 requires it: top-k hits and a threshold sweep
  over `docs/eval/retrieval-*.json`.
- **Ask before spending API credit**, and say roughly how many calls it will be. The owner is
  generous with it but wants to know where it goes.
- `app/config.json` holds a real key (35 characters). Never print it, never commit it, never package
  it. `release.ps1` swaps in the placeholder and verifies the artifact contains no key. **A second
  key for embeddings is planned and has no packaging check yet** — add it to `config.example.json`,
  the environment list and `Assert-PackagedContents` before it is used.

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
- **Memories supersede, never overwrite**; `/forget` genuinely deletes the whole chain. Memories are
  global; topics are local.
- **`api.js` exists because `main.js` cannot be loaded outside Electron** — anything left there can
  never be tested. Keep side requests there.
- **`build.files` is hand-maintained and has been forgotten three times.** A test walks the
  `require` graph in seconds; if you add a module, that test tells you.
- **A project is a container the owner fills, never one the app infers.** No inheritance on a
  boundary, no keyword rule, no model guess (ADR-014).
- **The project block is reference, not history, and it is derived.** Its rows are read at assembly
  time; there is no context table and no generated project summary (ADR-014).
- **HDD is a room, not a printer** (ADR-015). No code editing, no builds, tests or git, no
  orchestration, no panels. Long content is a file or a command output.
- **Execution is delegated, never inferred** (ADR-015). HDD proposes; the owner confirms; the brief
  is a file shown before sending; every handoff is recorded with its outcome.
- **Original text and the owner's note stay labelled** (ADR-016). The owner asks about the
  original; the answer must not quietly become a summary of their own summary.
- **`docs/eval/` entries are data**: adding a case is appending a turn and its judgement.

## Debts waiting, measured rather than suspected

The full list is at the end of `docs/ROADMAP.md`. The ones most likely to matter next:

- **The handoff's only evidence is a failure** (ROADMAP debt 23): headless runs tools without
  approval and its shell is broken under this configuration. Do not build L2 on "it works".
- **The reply budget is a starting value** (debt 24): 2–5 sentences / ~240 characters, not measured.
- **The first corpus is notes and highlights, not the full papers** (debt 25): PDF full text is the
  trigger.
- **The embedding key sits in `config.json`** (debt 26): gitignored, swapped for a placeholder by
  `release.ps1`, and checked alongside the chat key in the built asar.
- **The Zotero local API is a version surface** (debt 27): pin the version, keep the export
  fallback, and treat an unreachable Zotero as a sentence rather than an empty library.
- **`inspect.cjs` still has no listing for stored memories or projects**, and will need one for
  files. `--prompt` now uses the real assembler, so injected sections appear with their caps.
- **The project block's effect is still unmeasured.** The machine side is asserted; whether she uses
  the other topics, or misreads an excerpt as something said just now, needs a real conversation.
- **The packaged data-directory branch is untested at schema v6** (the last real launch was v5).
- **The Phase 5 commands were driven by hand on 2026-10-28** (`/zotero sync`, `/files`, `/embed`,
  `/recall`, `/hand`), and automatic injection was judged correct on the real library: citations
  matched, notes were not passed off as originals, both negative questions stayed empty, and reply
  length was right. `/forget`, `/remember`, `/projects` and `/project` are still test-only.

## What to do first next session

1. Read ADR-015 and ADR-016; they are the authority on everything below.
2. **Zotero client and full sync — done.** `zotero.js`, migration 7, `conversation.syncZotero`,
   `/zotero sync`, `/files`; 35 papers, 29 notes, 521 highlights, 1386 chunks, 0 dropped, 410 ms.
   `zotero.test.cjs` covers the grouping, chunk shapes, schema round-trip and the unreachable case.
3. **The chunker — done** for the three shapes (note paragraphs, highlight + comment, abstract).
4. **The embedding client and a real embed — done.** BGE-M3 embedded all 1386 chunks in 17.7 s at
   1024 dimensions, and `/recall` over the real library returned relevant papers and notes at
   0.71–0.62. The owner accepted option A (chunk text may go to SiliconFlow).
5. **`/recall` and the retrieval module — done, including automatic injection.** Brute-force
   cosine, top-k, two chunks per paper; the turn injects at most 3 chunks / 1200 characters above
   **0.55**, labelled as original, note or abstract, after the project block. **Next: `/read`**,
   then the capability/packaging pass and L1.
6. **The evaluation set and `probe --retrieval`** before any threshold exists. Use the real corpus:
   7 Chinese questions answered in English papers/highlights, 2 in Chinese notes, 1–2 with English
   terms. The provider is chosen in principle (BGE-M3) but is not proven — the conceptual margin was
   only 0.032.
7. **L1 is independent** and can be done in parallel: `/hand` writes a brief file, no provider, no
   schema, no network.
8. **The owner's five real questions split three ways**: paper listing and existence (`/recall`),
   reading a named document (`/read`), and **tasks and the schedule, which are Phase 7** — do not
   stretch retrieval to answer them.
