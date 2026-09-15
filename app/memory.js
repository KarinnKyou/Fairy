'use strict';
/*
 * memory.js — when is a turn worth asking about remembering?
 *
 * Pure policy: no database, no Electron, no network, no store import. conversation.js supplies the
 * text and acts on the answer; store.js holds the memories themselves.
 *
 * THIS MODULE DOES NOT DECIDE WHAT TO REMEMBER (ADR-013). It decides only *when it is worth
 * asking*, because the two halves of that question have different natures: "is there a fact about
 * the owner in this turn" is a judgement about meaning, and ADR-012 is this project's evidence
 * that a lexical rule cannot make one — asked to judge topic boundaries, it was wrong about half
 * the time on the first real transcript. So the model does the judging and this file only spends
 * the request.
 *
 * A cheap cue that fires a little too often is the deliberate choice, and the same bias as
 * `topics.js`: a memory that is never extracted is a smaller loss than a memory that is wrong,
 * and the request it costs is bounded by the cooldown below.
 *
 * The cue is "the owner is talking about themselves", not a list of sentence patterns. An earlier
 * draft matched specific phrasings — 我住在 / 我叫 / 我喜欢 — and missed 我在做 HDD 这个终端项目,
 * which is one of the most memorable things the owner has said. Verb patterns are endless;
 * first-person reference is not.
 */

/* A turn has to say something before it is worth a request. Two terms is enough: the valuable
 * disclosures are short ("我住杭州", "我叫小林"), and the first-person cue is what does the
 * selecting, not this floor. */
const MIN_SELF_TERMS = 3;

/* A correction is asked about even when it is short, because a stale belief that never gets
 * corrected is the exact failure this phase exists to prevent. */
const MIN_CORRECTION_TERMS = 2;

/*
 * How many turns must pass before asking again in the same topic.
 *
 * Without a cooldown the first-person cue fires constantly — 我 appears in 帮我推荐几部电影吧,
 * which holds no fact at all — and every firing costs a request. Four is a first estimate, not a
 * measurement; `docs/eval` is where it gets tuned, like the topic thresholds.
 */
const COOLDOWN_TURNS = 4;

/* First-person reference: the owner is the subject of the sentence. Deliberately blunt. */
const SELF_RE = /(我|咱|俺|自己)/;

/*
 * A first-person pronoun inside a request is an object, not a fact: 帮我推荐几部电影 says nothing
 * about the owner. Requests are the most common thing anyone says to a terminal assistant, so
 * leaving them in made the cue fire on most turns — measured on the first probe of this module,
 * three of the four wrong firings were exactly this shape.
 */
const REQUEST_FRAME_RE = /(帮我|给我|让我|请你|替我|教我|带我|你需要我)/g;

/* Is the owner the subject here, once requests have been set aside? */
function isSelfReference(text) {
  return SELF_RE.test(text.replace(REQUEST_FRAME_RE, ''));
}

/*
 * Known over-fire, kept deliberately: a request that mentions the owner twice still trips the cue —
 * 帮我看看我现在的表情 loses 帮我 and keeps 我的表情. Vetoing every utterance that opens with a
 * request would fix it and would also skip 帮我记一下我住在杭州, which states a fact in the one
 * phrasing a user is most likely to reach for. A wasted request is the cheaper mistake, and the
 * cooldown bounds how often it can repeat.
 */

/* Explicit correction or replacement of something previously believed. Kept short on purpose: a
 * pattern that fires on 现在 or 已经 would fire on half of ordinary conversation and bypass the
 * cooldown every time. What it misses, `docs/eval` can add. */
const CORRECTION_RE = /(不对|说错|改成|不再是|更正|纠正|搬家)/;

/* Reuse the topic tokenizer rather than inventing a second one: "content terms" should mean the
 * same thing in both policies, or the two sets of constants cannot be compared. */
const topics = require('./topics.js');

/*
 * Should this turn be put to the extractor?
 *
 * input: { text, turnsSinceAsk }
 *   text         — what the owner said this turn (the assistant's reply is context for the
 *                  extractor, not evidence about the owner, so it is not inspected here)
 *   turnsSinceAsk— turns since the last extraction was requested in this topic; null or a number
 *                  larger than the cooldown means "not recently". A restart loses this count, and
 *                  the cost of that is one extra request — cheaper than a schema change to persist
 *                  a counter whose only job is to save a request.
 *
 * Returns { ask, reason }, where reason is 'correction' | 'self' | 'cooldown' | 'nothing'.
 * `ask` means "spend one request"; it never means "store a memory" — the extractor decides that,
 * and may return nothing.
 */
function shouldExtract(input) {
  const opts = input || {};
  const text = String(opts.text == null ? '' : opts.text);
  const terms = new Set(topics.contentTerms(text));

  /* Corrections first, and outside the cooldown: a belief the owner has just contradicted must
   * not wait behind a request that was already spent on something else. */
  if (CORRECTION_RE.test(text) && terms.size >= MIN_CORRECTION_TERMS) {
    return { ask: true, reason: 'correction' };
  }

  if (!isSelfReference(text)) return { ask: false, reason: 'nothing' };
  if (terms.size < MIN_SELF_TERMS) return { ask: false, reason: 'nothing' };

  const since = opts.turnsSinceAsk;
  if (typeof since === 'number' && since < COOLDOWN_TURNS) {
    return { ask: false, reason: 'cooldown' };
  }
  return { ask: true, reason: 'self' };
}

/* A single turn should not be able to flood the prompt with forty facts. Five is generous for one
 * exchange, and the cap is a guard against a model that decides to summarise everything. */
const MAX_PER_TURN = 5;

/* A memory is a fact, not a paragraph. A longer answer is refused rather than truncated: cutting a
 * statement in half can turn it into a different, false one, and an oversized memory is a
 * prompt-budget problem (ADR-008) hiding in the data. */
const MAX_TEXT_CHARS = 200;

/*
 * Read the extractor's answer.
 *
 * This lives here rather than in `main.js` on purpose. `main.js` cannot be loaded outside Electron,
 * so anything left there has no coverage at all — which is how the topic-boundary parser became the
 * least-tested and most failure-prone piece of ADR-012. Pure parsing belongs in a module a test can
 * require.
 *
 * Returns `[]` when the answer is readable and says there is nothing to keep, and `null` when it
 * could not be read at all. The two are different: `[]` is an honest "nothing memorable here",
 * while `null` means the extractor is unusable, and every failure in this design points the same
 * way — an extractor that cannot answer must not be able to invent a fact about the owner.
 */
function parseExtraction(raw) {
  const s = String(raw == null ? '' : raw);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch (_) {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.memories)) return null;

  const out = [];
  for (const entry of parsed.memories) {
    if (out.length >= MAX_PER_TURN) break;
    if (!entry || typeof entry !== 'object') continue;
    const text = String(entry.text == null ? '' : entry.text).trim();
    if (!text || text.length > MAX_TEXT_CHARS) continue;
    const replaces = typeof entry.replaces === 'string' && entry.replaces.trim()
      ? entry.replaces.trim()
      : null;
    out.push({ text, replaces });
  }
  return out;
}

module.exports = {
  shouldExtract,
  isSelfReference,
  parseExtraction,
  MIN_SELF_TERMS,
  MIN_CORRECTION_TERMS,
  COOLDOWN_TURNS,
  MAX_PER_TURN,
  MAX_TEXT_CHARS,
  SELF_RE,
  REQUEST_FRAME_RE,
  CORRECTION_RE,
};
