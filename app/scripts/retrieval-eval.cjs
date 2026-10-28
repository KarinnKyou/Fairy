'use strict';
/*
 * retrieval-eval.cjs — replay docs/eval/retrieval-*.json against a scratch library.
 *
 * It syncs Zotero, embeds every chunk, asks each question, and reports hit@k plus a threshold
 * sweep over the scored hits. The point is to choose the injection threshold from data; the
 * report is written under app/data/probe/ so it can be read afterwards.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const conversation = require('../conversation.js');
const zotero = require('../zotero.js');
const embedding = require('../embedding.js');

const ROOT = path.join(__dirname, '..', '..');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const file = arg || 'docs/eval/retrieval-2026-10-28.json';
const corpus = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdd-eval-'));
  const conv = conversation.openConversation({
    dir,
    zotero: zotero.createClient({}),
    embedder: embedding.createEmbedder({
      baseUrl: process.env.HDD_EMBEDDING_BASE_URL,
      apiKey: process.env.HDD_EMBEDDING_API_KEY,
      model: process.env.HDD_EMBEDDING_MODEL,
    }),
  });
  const started = Date.now();
  const sync = await conv.syncZotero();
  const embed = await conv.embedLibrary({ limit: 2000 });
  console.log('sync ' + sync.chunks + ' chunks, embed ' + embed.embedded + '/' + embed.total +
    ' in ' + (Date.now() - started) + 'ms');

  const rows = [];
  for (const q of corpus.questions) {
    const r = await conv.recall(q.question, { limit: 10 });
    const hits = r.ok ? r.hits : [];
    const expect = (q.expect || []).map((s) => s.toLowerCase());
    let match = null;
    for (let i = 0; i < hits.length; i++) {
      if (expect.some((e) => String(hits[i].title || '').toLowerCase().includes(e))) {
        match = { rank: i + 1, title: hits[i].title, score: hits[i].score, kind: hits[i].kind };
        break;
      }
    }
    rows.push({
      question: q.question, negative: Boolean(q.negative),
      top1: hits[0] ? { title: hits[0].title, score: hits[0].score, kind: hits[0].kind } : null,
      match,
    });
  }

  for (const r of rows) {
    if (r.negative) {
      console.log('NEG  top1=' + (r.top1 ? r.top1.score.toFixed(3) : '-') + '  ' + r.question);
    } else {
      console.log((r.match ? 'HIT  @' + r.match.rank + ' ' + r.match.score.toFixed(3) : 'MISS        ') +
        '  ' + r.question);
    }
  }
  const pos = rows.filter((r) => !r.negative);
  const neg = rows.filter((r) => r.negative);
  for (const k of [1, 3, 5]) {
    console.log('hit@' + k + ': ' + pos.filter((r) => r.match && r.match.rank <= k).length + '/' + pos.length);
  }
  console.log('threshold  positives  negatives');
  for (let t = 0.4; t <= 0.801; t += 0.05) {
    const th = Number(t.toFixed(2));
    const p = pos.filter((r) => r.match && r.match.score >= th).length;
    const n = neg.filter((r) => r.top1 && r.top1.score >= th).length;
    console.log(th.toFixed(2) + '       ' + p + '/' + pos.length + '       ' + n + '/' + neg.length);
  }

  const outDir = path.join(ROOT, 'app', 'data', 'probe',
    'retrieval-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
    corpus: file, sync, embed, rows,
  }, null, 2));
  console.log('report: ' + outDir);
  conv.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((err) => { console.log('ERROR: ' + (err && err.stack || err)); process.exit(1); });
