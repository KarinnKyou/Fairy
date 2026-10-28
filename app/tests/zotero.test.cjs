'use strict';
/*
 * zotero.test.cjs — the library importer: HTML conversion, grouping through the attachment
 * layer, chunk shapes, migration 7, and a sync into a real temporary store.
 *
 * No network and no Zotero: the client takes an injected fetch, and the sync takes an injected
 * snapshot. That is the point of keeping the API shape in one module.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../store.js');
const zotero = require('../zotero.js');
const embedding = require('../embedding.js');
const conversation = require('../conversation.js');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('ok - ' + msg);
  else { failures++; console.error('FAIL - ' + msg); }
}
function eq(a, b, msg) { check(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ')'); }

const paperRow = {
  key: 'P1', version: 11,
  data: {
    itemType: 'journalArticle', title: 'Instance Space Analysis',
    creators: [{ lastName: 'Pérez' }, { lastName: 'Smith' }],
    date: '2026-03-01', tags: [{ tag: 'scheduling' }],
    abstractNote: 'A survey of instance space analysis.',
  },
};
const noteRow = {
  key: 'N1', version: 12,
  data: { parentItem: 'P1', note: '<h2>核心</h2><p>这篇用实例空间分析。</p><ul><li>第一点</li></ul>' },
};
const standalone = { key: 'N2', version: 13, data: { note: '<p>独立笔记</p>' } };
const attRow = { key: 'ATT1', version: 14, data: { parentItem: 'P1', contentType: 'application/pdf' } };
const annRow = {
  key: 'A1', version: 15,
  data: {
    parentItem: 'ATT1', annotationType: 'highlight',
    annotationText: 'The exact English sentence.', annotationComment: '我的批注',
    annotationPageLabel: '45:15',
  },
};

function fakeFetch() {
  const table = {
    attachment: [attRow], note: [noteRow, standalone], annotation: [annRow],
    journalArticle: [paperRow], conferencePaper: [], preprint: [], book: [], bookSection: [], thesis: [],
  };
  return async (url) => {
    const type = decodeURIComponent((url.match(/itemType=([^&]+)/) || [])[1] || '');
    const rows = table[type] || [];
    const start = Number((url.match(/start=(\d+)/) || [])[1] || 0);
    const pageRows = start === 0 ? rows : [];
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'total-results' ? String(rows.length) : '1001') },
      json: async () => pageRows,
      text: async () => '',
    };
  };
}

function vecFor(text) {
  const v = new Float32Array(8);
  for (const ch of String(text)) v[ch.codePointAt(0) % 8] += 1;
  return embedding.normalize(v);
}
const fakeEmbedder = {
  configured: true, model: 'fake',
  embed: async (texts) => texts.map(vecFor),
  embedOne: async (text) => vecFor(text),
};
const fakeEmbFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  return {
    ok: true, status: 200,
    json: async () => ({ data: body.input.map((t) => ({ embedding: vecFor(t) })) }),
    text: async () => '',
  };
};

(async () => {
  /* 1. HTML to text, entities and structure. */
  const text = zotero.htmlToText('<h2>标题</h2><p>甲&amp;乙</p><ul><li>一</li></ul>');
  check(text.includes('标题') && text.includes('甲&乙') && text.includes('- 一'), 'HTML 转文本保留标题、实体和列表');
  check(!/[<>]/.test(text), 'HTML 标签被去掉');

  /* 2. Snapshot groups note -> paper and highlight -> attachment -> paper. */
  const snap = await zotero.createClient({ fetchImpl: fakeFetch() }).snapshot();
  eq(snap.papers.length, 1, '只有一篇论文');
  eq(snap.papers[0].notes.length, 1, '笔记挂在论文下');
  eq(snap.papers[0].highlights.length, 1, '高亮经附件映射到论文');
  eq(snap.standaloneNotes.length, 1, '无父条目的笔记单独保留');
  eq(snap.papers[0].highlights[0].page, '45:15', '高亮保留页码');
  eq(snap.papers[0].highlights[0].comment, '我的批注', '高亮保留批注');

  /* 3. Chunks: abstract, note, highlight+comment, with kinds. */
  const chunks = zotero.chunksFor(snap.papers[0]);
  const kinds = chunks.map((c) => c.kind);
  check(kinds.includes('abstract') && kinds.includes('note') && kinds.includes('highlight'),
    '三种块都生成：' + JSON.stringify(kinds));
  const hi = chunks.find((c) => c.kind === 'highlight');
  check(hi.text.includes('The exact English sentence.') && hi.text.includes('我的批注'), '高亮块含原文和批注');
  eq(hi.page, '45:15', '高亮块带页码');
  eq(chunks.map((c) => c.ordinal), chunks.map((_, i) => i), 'ordinal 从 0 连续');

  /* 4. Migration 7 + store round-trip in a real temporary database. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdd-zotero-'));
  const s = store.open({ dir });
  check(s.schemaVersion >= 7, '新库 schema 至少 v7（' + s.schemaVersion + '）');

  const id = store.upsertZoteroFile(s.db, Object.assign({}, snap.papers[0], {
    content: zotero.paperContent(snap.papers[0]),
  }));
  check(Boolean(id), '论文写入 files');
  eq(store.replaceChunks(s.db, id, chunks), chunks.length, '块写入数量一致');
  const listed = store.listFiles(s.db);
  eq(listed.length, 1, 'listFiles 返回一条');
  eq(listed[0].chunkCount, chunks.length, 'listFiles 报告块数');
  eq(store.chunksForFile(s.db, id).length, chunks.length, 'chunksForFile 返回全部块');

  const again = store.upsertZoteroFile(s.db, Object.assign({}, snap.papers[0], {
    content: zotero.paperContent(snap.papers[0]),
  }));
  eq(again, id, '同一 zotero_key 再同步不会新建行');
  eq(store.countFiles(s.db), 1, 'countFiles 仍是一条');

  store.deleteFile(s.db, id);
  eq(store.countFiles(s.db), 0, '删除文件');
  eq(store.listFiles(s.db).length, 0, '删除后列表为空');
  store.close(s);
  fs.rmSync(dir, { recursive: true, force: true });

  /* 5. Vectors: normalisation, BLOB round-trip, cosine. */
  const v1 = embedding.normalize(Float32Array.from([1, 0, 0]));
  const v2 = embedding.normalize(Float32Array.from([0, 1, 0]));
  check(Math.abs(embedding.cosine(v1, v2)) < 1e-6, '正交向量的余弦为 0');
  const back = embedding.fromBlob(embedding.toBlob([3, 0, 0]));
  check(back.length === 3 && Math.abs(back[0] - 1) < 1e-6, 'BLOB 往返且已归一化');
  check(embedding.fromBlob(Buffer.alloc(0)) === null, '空 BLOB 解出 null');

  /* 6. The embedding client: batch success, no key, HTTP failure. */
  const emb = embedding.createEmbedder({ apiKey: 'k', model: 'fake', fetchImpl: fakeEmbFetch });
  eq((await emb.embed(['a', 'b'])).length, 2, '批量嵌入返回两条');
  check((await embedding.createEmbedder({ apiKey: '', fetchImpl: fakeEmbFetch }).embed(['a'])) === null,
    '没有 key 时返回 null');
  check((await embedding.createEmbedder({
    apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
  }).embed(['a'])) === null, 'HTTP 失败时返回 null');

  /* 7. syncZotero writes one paper, its note, its highlight, and a standalone note. */
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hdd-zotero-'));
  const conv = conversation.openConversation({
    dir: dir2, zotero: { snapshot: async () => snap }, embedder: fakeEmbedder,
  });
  const result = await conv.syncZotero();
  check(result.ok === true, '同步成功');
  eq(result.papers, 1, '同步一篇论文');
  eq(result.notes, 2, '同步两条笔记（论文下一条 + 独立一条）');
  eq(result.highlights, 1, '同步一条高亮');
  check(result.chunks >= 3, '同步生成至少三块（' + result.chunks + '）');
  const files = conv.files();
  eq(files.length, 2, '论文 + 独立笔记两条 file（' + files.length + '）');
  check(files.some((f) => f.kind === 'note'), '独立笔记的 kind 是 note');

  /* 8. Embedding the library, then a semantic recall over it. */
  const embedded = await conv.embedLibrary({ limit: 100 });
  check(embedded.ok && embedded.embedded === embedded.total, '全部块嵌入（' + embedded.embedded + '/' + embedded.total + '）');
  eq(embedded.remaining, 0, '没有剩余未嵌入的块');
  eq(store.countEmbeddedChunks(conv._store.db, 'fake'), embedded.total, '库里的嵌入数与块数一致');
  const rec = await conv.recall('The exact English sentence', { limit: 5 });
  check(rec.ok && rec.hits.length > 0, '语义检索有结果');
  check(rec.hits.some((h) => h.kind === 'highlight'), '命中里包含高亮块');
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdd-zotero-'));
  const recBefore = conversation.openConversation({ dir: emptyDir, embedder: fakeEmbedder });
  const noEmb = await recBefore.recall('anything');
  check(noEmb.ok === false && noEmb.reason === 'no-embeddings', '没有嵌入时明确返回 no-embeddings');
  recBefore.close();
  fs.rmSync(emptyDir, { recursive: true, force: true });
  conv.close();
  fs.rmSync(dir2, { recursive: true, force: true });

  /* 9. The prompt section: labelled, bounded, and empty when nothing clears the threshold. */
  const section = conversation.fileSection([
    { title: 'Paper', kind: 'highlight', page: '45:15', score: 0.7, text: 'The exact English sentence.' },
    { title: 'Note', kind: 'note', page: null, score: 0.6, text: '我的笔记' },
    { title: 'Low', kind: 'note', page: null, score: 0.4, text: 'below threshold' },
  ]);
  check(section.includes('文件参考') && section.includes('高亮 p.45:15') && section.includes('笔记'),
    '文件参考段带来源标签');
  check(!section.includes('below threshold'), '低于阈值的块不进入提示词');
  check(conversation.fileSection([]) === '', '没有命中时没有段');
  const withFiles = conversation.buildMessages({
    persona: 'P', identity: { turns: 1, firstSeen: 0, lastSeen: null }, now: Date.now(),
    files: [{ title: 'Paper', kind: 'highlight', page: '45:15', score: 0.7, text: 'The exact English sentence.' }],
  });
  check(withFiles[0].content.includes('文件参考') && withFiles[0].content.includes('Paper'),
    '系统提示里带着检索到的片段');

  /* 10. An unreachable client is a result, not a throw and not an empty library. */
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hdd-zotero-'));
  const conv2 = conversation.openConversation({
    dir: dir3,
    zotero: { snapshot: async () => { throw new Error('connect ECONNREFUSED'); } },
  });
  const failed = await conv2.syncZotero();
  check(failed.ok === false && failed.reason === 'unreachable', '连不上 Zotero 时返回 unreachable');
  eq(conv2.files().length, 0, '失败时库仍为空，没有被写成“已同步”');
  conv2.close();
  fs.rmSync(dir3, { recursive: true, force: true });

  if (failures) { console.error('\n' + failures + ' failed'); process.exit(1); }
  console.log('\nall passed');
})();
