# HDD v0.5

A Fairy-themed desktop terminal: a full-screen window with a centred mascot that changes state as
the conversation progresses, and CMD-style terminal input/output below it. Conversations are driven
by the **DeepSeek API** (SSE streaming).

**This release gives her your library.** HDD reads the Zotero library on this machine — papers,
your Chinese notes, and the English sentences you highlighted, with their page numbers — and uses
the relevant few when it answers. Ask in Chinese; she answers from the original and says which
paper and which passage it came from.

---

## Quick start (using the prebuilt exe)

Download **`HDD-0.5.0.exe`** (single portable file, no install, Windows x64).

> **This exe contains no API key.** You must configure two keys as described below, or the library
> features stay off.

### 1. Run it

Double-click `HDD-0.5.0.exe`. SmartScreen may block it on first launch (unsigned local build) —
choose "More info → Run anyway".

- **Esc** quits
- Type in the input row and press **Enter**
- Type `/help` for the commands

### 2. Configure the keys

The chat key is DeepSeek. The embedding key is a second provider, because DeepSeek exposes no
embeddings endpoint (measured: `/embeddings` returns 404 while `/v1/chat/completions` returns 200).
SiliconFlow's `BAAI/bge-m3` is what this release was built and measured against.

A portable exe does not read a `config.json` next to it; use environment variables:

```powershell
setx DEEPSEEK_API_KEY "sk-your-deepseek-key"
setx HDD_EMBEDDING_API_KEY "sk-your-siliconflow-key"
setx HDD_EMBEDDING_BASE_URL "https://api.siliconflow.cn/v1"
setx HDD_EMBEDDING_MODEL "BAAI/bge-m3"
```

Then restart the app. When running from source, the same four values can live in
`app/config.json` (see `app/config.example.json`); environment variables win.

### 3. Font

The published exe contains no font (licensing) and renders in the system sans-serif. To build with
your own, put a CJK font in `app/fonts/` and run `npm run dist`.

---

## What is new since v0.4

### Your Zotero library, read locally

| Command | What it does |
| --- | --- |
| `/zotero` | Library status |
| `/zotero sync` | Read papers, notes and highlights from Zotero's local API and store them |
| `/files` | What is in the library, with chunk counts |
| `/embed` | Embed the chunks that have no vector yet |
| `/recall <描述>` | Semantic search: score and source for each hit |
| `/read <标题\|序号>` | Attach one paper to the following turns; `/read off` detaches |
| `/hand <需求>` | Write a brief for the harness; it is never sent automatically |

The sync uses `http://127.0.0.1:23119/api/users/0` — **no Zotero key, no cloud, no export**. A
highlight's parent is its PDF attachment, and the importer maps it back to the paper. On the
reference library: 35 papers, 29 notes, 521 highlights, 1386 chunks, nothing dropped.

### What she is told — and what she is not

When a turn's question is close enough to the library (above a **measured** threshold of 0.55), the
system prompt gains at most three chunks / 1200 characters, each labelled:

- `【论文 · 高亮 p.45:15】…` — the paper's own sentence;
- `【论文 · 笔记】…` — your summary, explicitly not the paper's words;
- `【论文 · 摘要】…`

A failed lookup is an empty section. Nothing is injected for unrelated questions: on the two
negative questions the best scores were 0.532 and 0.396, below the threshold.

### The threshold is a number, not a taste

`docs/eval/retrieval-2026-10-28.json` holds 11 positive and 2 negative questions written the way
they are actually asked. Replaying them: hit@1 6/11, hit@3 9/11; at **0.55**, 10/11 positives kept
and 0/2 false positives. 0.60 keeps 9/11; 0.65 collapses to 2/11. `npm run probe:retrieval`
replays it.

### `/read` and `/hand`

`/read` attaches one named document — the library's assembled material, not the PDF body — for the
following turns, capped at 8000 characters and with no generated summary.

`/hand` writes a deterministic brief (need, topic, project, memories, recent turns, constraints,
acceptance, reply contract) under `app/data/handoffs/`. It stops there: nothing is spawned or sent.

### No Markdown

Terminal replies are plain text. The persona forbids Markdown, and the renderer strips `**` even
when the two asterisks arrive in different stream deltas.

---

## Testing it yourself

```
cd app
npm test                                   # five suites, no network, no window
npm run dev:fresh                          # scratch store, safe to experiment
```

Then, in the window:

```
/zotero sync
/files
/embed
/recall 图注意力网络是怎么计算注意力的？
/read Graph Attention Networks
/hand 把发布流程里的密钥检查补上
```

Ask, without a slash: 「POMO 为什么用多个最优解？」「我的笔记里怎么评价 instance space analysis？」
「量子计算机的退相干时间是多少？」(the last one should not cite the library).

The manual pass on 2026-10-28 covered sync, files, embed, recall, read, handoff and automatic
injection; citations matched, notes were not passed off as originals, and the negative questions
stayed empty.

---

## Known limitations

- **PDF full text is not parsed.** The library holds abstracts, your notes and the highlighted
  sentences; an unhighlighted passage cannot be answered from the paper body. No OCR, no two-column
  reconstruction.
- **The sync refetches everything**; 1386 chunks are small enough that this is not yet a problem.
- **0.55 comes from one library.** It must be re-measured as `docs/eval` grows.
- **`/hand` is L1 only.** The one headless trial failed on this machine's shell configuration; the
  harness is not spawned by HDD yet.
- **Zotero must be running** for a sync.
- **The embedding key is a second secret.** Both keys are swapped for placeholders by `release.ps1`,
  and the built asar is checked for both; a private `npm run dist` still embeds whatever is in
  `config.json`.
- Windows x64 only, always full-screen, `Esc` quits, no cancel for a reply in progress.
- The published exe contains no font and renders in the system sans-serif.

## Roadmap

`v0.1` → `v0.2` → `v0.3` → `v0.4` → `v0.5` → ... → `v1.0`. Phase 6 is now narrow: a few safe local
actions and the handoff audit, not a tool platform — execution is delegated to the harness (ADR-015).

## License and notices

- Apache License 2.0, © 2026 Chengzhibense (see `LICENSE` / `NOTICE`)
- The released exe bundles **Electron** (MIT) and Chromium; their notices ship beside it
- Visual assets originate from **Fairy-DSH-main**; the repository contains no font files, official
  assets or private corpora
- The names "Fairy", "DSH" and "DeepSeek" imply no official affiliation
- This exe contains no API key and no embedding key; supply your own
