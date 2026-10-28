'use strict';
/*
 * zotero.js — read the owner's library through Zotero's local API (ADR-016).
 *
 * Zotero 10 answers on 127.0.0.1:23119 with no key and no authentication. What comes back is
 * already structured: notes carry HTML, highlights carry an exact English sentence, the owner's
 * Chinese comment and a page label, papers carry title/authors/date/abstract. The module is pure
 * except for one injected fetch, so a test never needs Zotero running.
 *
 * The one shape that is not flat: a highlight's parentItem is its PDF attachment, and the
 * attachment's parentItem is the paper. Attachments are therefore fetched first and mapped.
 */

const DEFAULT_BASE = 'http://127.0.0.1:23119/api/users/0';
const PAGE_SIZE = 100;
const CHUNK_TARGET = 500;
const CHUNK_HARD_MAX = 900;
const PAPER_TYPES = [
  'journalArticle', 'conferencePaper', 'preprint', 'book', 'bookSection', 'thesis',
  'report', 'document', 'manuscript', 'webpage', 'newspaperArticle', 'magazineArticle',
];

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
};

/* Notes arrive as HTML. This is deliberately a small converter, not a parser: the corpus is
 * Zotero's own note editor output, and a dependency for six tags would buy nothing. */
function htmlToText(html) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ');
  s = s.replace(/&[a-z#0-9]+;/gi, (m) => {
    if (ENTITIES[m.toLowerCase()]) return ENTITIES[m.toLowerCase()];
    const num = m.match(/^&#(x?)([0-9a-f]+);$/i);
    if (num) return String.fromCodePoint(parseInt(num[2], num[1] ? 16 : 10));
    return ' ';
  });
  return s.replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* Cut text at paragraph boundaries where possible, hard-cut only when one paragraph is longer
 * than a chunk. Deterministic: same input, same chunks. */
function splitText(text, target) {
  const limit = target || CHUNK_TARGET;
  const parts = String(text == null ? '' : text).split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const p of parts) {
    if (p.length > CHUNK_HARD_MAX) {
      flush();
      for (let i = 0; i < p.length; i += limit) out.push(p.slice(i, i + limit).trim());
      continue;
    }
    if (!buf) buf = p;
    else if (buf.length + 1 + p.length <= limit) buf += '\n' + p;
    else { flush(); buf = p; }
  }
  flush();
  return out;
}

function toPaper(row) {
  const d = (row && row.data) || {};
  const creators = (d.creators || [])
    .map((c) => c.lastName || c.name || c.firstName || '')
    .filter(Boolean)
    .join(', ');
  const yearMatch = String(d.date || '').match(/\d{4}/);
  const tags = (d.tags || []).map((t) => t.tag).filter(Boolean);
  return {
    key: row.key,
    version: row.version,
    title: String(d.title || '(untitled)'),
    itemType: d.itemType || '',
    year: yearMatch ? Number(yearMatch[0]) : null,
    creators,
    tags,
    abstract: String(d.abstractNote || ''),
    notes: [],
    highlights: [],
  };
}

/*
 * Turn the four fetched collections into one array of papers, each with its notes and highlights.
 * A note whose parent is missing becomes a standalone note; an annotation whose attachment (or
 * attachment parent) is missing is dropped rather than guessed at.
 */
function group(papers, notes, annotations, attachments) {
  const byKey = new Map();
  for (const p of papers) byKey.set(p.key, p);

  const attachParent = new Map();
  for (const a of attachments) {
    const d = (a && a.data) || {};
    if (a.key && d.parentItem) attachParent.set(a.key, d.parentItem);
  }

  const standaloneNotes = [];
  for (const n of notes) {
    const d = (n && n.data) || {};
    const text = htmlToText(d.note);
    if (!text) continue;
    const entry = { key: n.key, version: n.version, text, title: String(d.title || ''), parentKey: d.parentItem || null };
    const parent = entry.parentKey ? byKey.get(entry.parentKey) : null;
    if (parent) parent.notes.push(entry);
    else standaloneNotes.push(entry);
  }

  let dropped = 0;
  for (const a of annotations) {
    const d = (a && a.data) || {};
    const attachKey = d.parentItem || null;
    const paperKey = attachKey ? attachParent.get(attachKey) : null;
    const paper = paperKey ? byKey.get(paperKey) : null;
    const text = String(d.annotationText || '').trim();
    if (!paper || !text) { dropped++; continue; }
    paper.highlights.push({
      key: a.key,
      version: a.version,
      text,
      comment: String(d.annotationComment || '').trim(),
      page: d.annotationPageLabel || null,
    });
  }

  return { papers: Array.from(byKey.values()), standaloneNotes, dropped };
}

/* The assembled content of a paper, used by /read and by the chunker's source.
 * It is derived, not a summary: abstract, then the owner's notes, then the highlighted sentences. */
function paperContent(paper) {
  const lines = ['# ' + paper.title];
  const meta = [paper.creators, paper.year ? String(paper.year) : ''].filter(Boolean).join(' · ');
  if (meta) lines.push(meta);
  if (paper.abstract) lines.push('', '## 摘要', paper.abstract);
  if (paper.notes.length) {
    lines.push('', '## 笔记');
    for (const n of paper.notes) lines.push(n.text);
  }
  if (paper.highlights.length) {
    lines.push('', '## 高亮');
    for (const h of paper.highlights) {
      lines.push('- ' + (h.page ? 'p.' + h.page + '：' : '') + h.text);
      if (h.comment) lines.push('  批注：' + h.comment);
    }
  }
  return lines.join('\n');
}

/* Chunks for one paper: abstract, each note, each highlight+comment. A highlight is one chunk
 * because it is one thought; a note is many paragraphs and is packed. */
function chunksFor(paper) {
  const out = [];
  const push = (kind, page, text) => {
    for (const piece of splitText(text)) out.push({ kind, page: page || null, text: piece });
  };
  if (paper.abstract) push('abstract', null, paper.abstract);
  for (const n of paper.notes) push('note', null, n.text);
  for (const h of paper.highlights) {
    const text = h.comment ? h.text + '\n批注：' + h.comment : h.text;
    push('highlight', h.page, text);
  }
  return out.map((c, i) => Object.assign({ ordinal: i }, c));
}

function createClient(options) {
  const opts = options || {};
  const baseUrl = String(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);

  async function page(itemType, start) {
    if (!fetchImpl) throw new Error('no fetch available');
    const url = baseUrl + '/items?itemType=' + encodeURIComponent(itemType) +
      '&limit=' + PAGE_SIZE + '&start=' + start;
    const res = await fetchImpl(url);
    if (!res || !res.ok) {
      const detail = res && res.text ? await res.text().catch(() => '') : '';
      throw new Error('Zotero HTTP ' + (res ? res.status : '?') + ' ' + String(detail).slice(0, 120));
    }
    const rows = await res.json();
    return {
      rows: Array.isArray(rows) ? rows : [],
      total: Number(res.headers && res.headers.get && res.headers.get('total-results')) || rows.length,
      version: Number(res.headers && res.headers.get && res.headers.get('last-modified-version')) || 0,
    };
  }

  async function allWithVersion(itemType) {
    const out = [];
    let start = 0;
    let version = 0;
    for (;;) {
      const p = await page(itemType, start);
      if (!version) version = p.version;
      out.push(...p.rows);
      start += p.rows.length;
      if (!p.rows.length || start >= p.total) break;
    }
    return { rows: out, version };
  }

  async function all(itemType) {
    return (await allWithVersion(itemType)).rows;
  }

  async function snapshot() {
    const attachments = await all('attachment');
    const notes = await allWithVersion('note');
    const annotations = await all('annotation');
    const paperRows = [];
    for (const t of PAPER_TYPES) paperRows.push(...await all(t));
    const papers = paperRows.map(toPaper).filter((p) => p.key);
    const grouped = group(papers, notes.rows, annotations, attachments);
    return {
      version: notes.version,
      papers: grouped.papers,
      standaloneNotes: grouped.standaloneNotes,
      droppedAnnotations: grouped.dropped,
    };
  }

  return { baseUrl, all, snapshot };
}

module.exports = {
  createClient,
  htmlToText,
  splitText,
  toPaper,
  group,
  paperContent,
  chunksFor,
  DEFAULT_BASE,
  PAGE_SIZE,
  CHUNK_TARGET,
};
