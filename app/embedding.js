'use strict';
/*
 * embedding.js — the one outbound request that is not a chat completion (ADR-016).
 *
 * The corpus is the owner's own notes and highlights, so this module refuses to guess: no key,
 * a bad status, a timeout, a short answer or inconsistent dimensions all return null, and the
 * caller stores nothing. A vector that was not produced must never look like a vector.
 *
 * Vectors are normalised before storage, so similarity is a dot product; the decoder still
 * computes a full cosine, because a stored vector could have come from an older build.
 */

const DEFAULT_BASE = 'https://api.siliconflow.cn/v1';
const DEFAULT_MODEL = 'BAAI/bge-m3';
const BATCH_SIZE = 32;
const BATCH_CHARS = 12000;
const TIMEOUT_MS = 30000;

function normalize(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n);
  const out = new Float32Array(vec.length);
  if (!n) return out;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

function toBlob(vec) {
  const f = normalize(Float32Array.from(vec));
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function fromBlob(blob) {
  if (!blob) return null;
  const b = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (!b.length || b.length % 4) return null;
  const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  return Float32Array.from(f);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function createEmbedder(options) {
  const opts = options || {};
  const baseUrl = String(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const apiKey = String(opts.apiKey || '');
  const model = String(opts.model || DEFAULT_MODEL);
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);

  function batches(texts) {
    const out = [];
    let cur = [];
    let chars = 0;
    for (const t of texts) {
      const s = String(t == null ? '' : t);
      if (cur.length && (cur.length >= BATCH_SIZE || chars + s.length > BATCH_CHARS)) {
        out.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(s);
      chars += s.length;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  async function request(batch) {
    if (!fetchImpl) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(baseUrl + '/embeddings', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
        signal: controller.signal,
      });
      if (!res || !res.ok) return null;
      const data = await res.json();
      const vectors = (data.data || []).map((d) => d.embedding);
      if (vectors.length !== batch.length) return null;
      const dim = vectors[0] && vectors[0].length;
      if (!dim || vectors.some((v) => !v || v.length !== dim)) return null;
      return vectors;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function embed(texts) {
    if (!apiKey || !fetchImpl) return null;
    const list = Array.isArray(texts) ? texts : [];
    if (!list.length) return [];
    const out = [];
    for (const b of batches(list)) {
      const vectors = await request(b);
      if (!vectors) return null;
      out.push(...vectors);
    }
    return out;
  }

  async function embedOne(text) {
    const vectors = await embed([text]);
    if (!vectors || !vectors.length) return null;
    return normalize(Float32Array.from(vectors[0]));
  }

  return { baseUrl, model, configured: Boolean(apiKey), embed, embedOne };
}

module.exports = {
  createEmbedder,
  normalize,
  toBlob,
  fromBlob,
  cosine,
  DEFAULT_BASE,
  DEFAULT_MODEL,
  BATCH_SIZE,
  BATCH_CHARS,
};
