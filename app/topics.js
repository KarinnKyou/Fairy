'use strict';
/*
 * topics.js — decide when the conversation has moved to a new subject, and name it.
 *
 * Pure policy: no database, no Electron, no network, no store import. conversation.js
 * supplies the recent text and applies the answer; store.js persists the result. Keeping
 * the decision in its own module is what makes it assertable in plain Node and tunable
 * without touching the data layer — ADR-010 expects exactly this behaviour to be tuned
 * against real conversations.
 *
 * Deliberately NOT model-assisted. Asking the model "is this a new topic?" would cost a
 * round trip per turn and make the decision impossible to assert offline, while every
 * signal needed here is already in the store. Titles are derived for the same reason.
 *
 * Lexical overlap is measured on CJK bigrams, not on the single characters the FTS index
 * uses (store.tokenizeForIndex). Single characters overlap almost everywhere — 的, 我, 不
 * appear in unrelated sentences — so they would report continuity between topics that have
 * nothing to do with each other. Bigrams are the shortest unit that carries subject
 * meaning in Chinese, which is also why the FTS index cannot use them: they cannot index
 * a two-character query word.
 */

/* All of these are guesses that the Phase 2 evaluation set is meant to correct. They are
 * named and exported for that reason, not because they are known to be right. */

/* A gap this long means "a new sitting", not "a new sentence". */
const IDLE_GAP_MS = 6 * 60 * 60 * 1000;

/* How many of the current topic's newest messages count as "the current subject". */
const RECENT_WINDOW_MESSAGES = 8;

/*
 * A message carrying fewer content terms than this is not evidence of anything, and short
 * messages are where lexical matching fails hardest.
 *
 * Measured over labelled exchanges (a connected continuation in one column, a genuine change
 * of subject in the other): every false split sat at 7 terms or fewer, and the shortest
 * genuine change of subject that is still worth catching carries 8. The value below is the
 * top of that gap, which is the side that avoids the expensive mistake — see SHIFT_COVERAGE
 * for why a false split costs more than a missed one.
 *
 * What this deliberately gives up: a short request that really does start a new subject
 * ("推荐几部电影", "附近有什么好吃的", 5–6 terms) is merged into the current topic instead of
 * splitting it. That is a wrong grouping inside one topic, not a lost conversation, and
 * `/new` states the intent explicitly. Whether the gap sits at 8 for real conversations is
 * for the evaluation set to say (ADR-010); the first guess of 3 split three of four
 * connected short exchanges in a row.
 */
const MIN_TERMS_TO_JUDGE = 8;

/*
 * Share of the new message's content terms that must already be on-topic for the message to
 * count as a continuation of the current subject.
 *
 * Set this low on purpose, because the two possible mistakes are not equally bad. Splitting
 * a topic that was still going means the next reply is assembled without the subject it
 * belongs to, so she appears to have forgotten the conversation — the failure COMMANDS.md
 * section 8 tells you to debug with `inspect`. Merging two subjects that briefly share a
 * word only puts a few unrelated messages in one topic, which search still survives.
 *
 * Measured on the probe cases: a subject continued in different words ("那个软件接下来想
 * 加个本事") scores 0.05–0.08 while genuine changes ("给我推荐几部科幻电影吧") score 0. At
 * 0.05 the paraphrase cases continue and the changes still split. A value of 0.12 — the
 * first guess — split both paraphrases.
 */
const SHIFT_COVERAGE = 0.05;

/*
 * After a long gap, a slightly thinner lexical link is accepted as evidence that the old
 * subject is being picked up again.
 *
 * This band is deliberately narrow (0.05–0.20), so the idle rule rarely changes the answer:
 * a message about a genuinely different subject has no overlap and the shift rule already
 * splits it, while a message that resumes the old subject in its own words shares enough to
 * continue. What it adds is the middle case — hours later, a message with only an incidental
 * word in common. Whether that earns its place is a question for the evaluation set
 * (ADR-010), not for this comment.
 */
const IDLE_COVERAGE = 0.2;

const TITLE_MAX_CHARS = 24;
const FALLBACK_TITLE = '未命名话题';

/* Address terms and function words. They are frequent, they appear across unrelated
 * subjects, and counting them as shared vocabulary would hide every topic change. */
const STOP_BIGRAMS = new Set([
  '什么', '怎么', '为什', '一个', '一些', '一下', '一点', '一直', '一起',
  '我们', '你们', '他们', '她们', '这个', '那个', '哪个', '这些', '那些',
  '可以', '这样', '那样', '怎样', '如果', '因为', '所以', '但是', '不过',
  '就是', '还是', '或者', '而且', '然后', '已经', '没有', '不是', '不能',
  '时候', '现在', '今天', '明天', '昨天', '知道', '觉得', '应该', '可能',
  '需要', '希望', '帮我', '帮忙', '请问', '谢谢', '好的', '好吧', '是的',
  '主人', '你好', '对了', '有点', '多少', '几个', '一样', '真的', '其实',
]);

/* Only reached by one-character CJK runs, which are usually a bare interjection. */
const STOP_SINGLE = new Set([
  '的', '了', '我', '你', '他', '她', '它', '是', '在', '有', '和', '就', '不', '也',
  '都', '吗', '呢', '吧', '啊', '嗯', '哦', '好', '这', '那', '会', '要', '能', '请',
  '给', '让', '把', '被', '与', '及', '或', '而', '但', '很', '太', '再', '又', '还',
  '只', '个', '些', '地', '得', '着', '过', '上', '下', '中', '来', '去', '对', '没',
]);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'are', 'with', 'this', 'that', 'what', 'how', 'can',
  'please', 'thanks', 'thank', 'from', 'have', 'been', 'will', 'would', 'about',
  'your', 'our', 'its', 'but', 'not', 'all', 'any', 'out', 'don', 'does',
]);

const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g;
const LATIN_RE = /[a-z0-9][a-z0-9._+-]*/g;

/*
 * The content terms of a piece of text: CJK bigrams plus whole Latin words, with common
 * function words removed. Order is preserved (useful when reading a failure) and callers
 * that count matches should dedupe.
 */
function contentTerms(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  const out = [];

  let m;
  LATIN_RE.lastIndex = 0;
  while ((m = LATIN_RE.exec(s)) !== null) {
    if (m[0].length >= 2 && !STOP_WORDS.has(m[0])) out.push(m[0]);
  }

  CJK_RUN_RE.lastIndex = 0;
  while ((m = CJK_RUN_RE.exec(s)) !== null) {
    const run = m[0];
    if (run.length === 1) {
      if (!STOP_SINGLE.has(run)) out.push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bigram)) out.push(bigram);
    }
  }
  return out;
}

/*
 * How much of the new message is already on-topic: the share of its distinct content terms
 * that also appear in the current subject's recent text. A message with no content terms at
 * all returns 1 — "no evidence of change" must not read as "change".
 */
function coverage(newTerms, recentTerms) {
  const unique = new Set(newTerms);
  if (!unique.size) return 1;
  const recent = new Set(recentTerms);
  let hit = 0;
  for (const term of unique) if (recent.has(term)) hit++;
  return hit / unique.size;
}

/*
 * Decide whether this message opens a new topic.
 *
 * input: { hasTopic, lastMessageAt, now, text, recentTexts }
 *   hasTopic      — is there a current topic to continue?
 *   lastMessageAt — when the newest message of that topic was written (0 if none)
 *   now           — wall clock, injected so tests do not have to wait six hours
 *   recentTexts   — the current topic's newest messages, oldest first
 *
 * Returns { isNew, reason }, where reason is 'first' | 'idle' | 'shift' | 'continue'.
 * The reason is not decoration: it is what a failing evaluation case is diagnosed with.
 */
function decideBoundary(input) {
  const opts = input || {};
  if (!opts.hasTopic) return { isNew: true, reason: 'first' };

  const terms = contentTerms(opts.text);
  const unique = new Set(terms);
  if (unique.size < MIN_TERMS_TO_JUDGE) return { isNew: false, reason: 'continue' };

  const score = coverage(unique, contentTerms((opts.recentTexts || []).join('\n')));
  const idle = Boolean(opts.lastMessageAt) && opts.now - opts.lastMessageAt >= IDLE_GAP_MS;

  if (idle) {
    return score < IDLE_COVERAGE
      ? { isNew: true, reason: 'idle' }
      : { isNew: false, reason: 'continue' };
  }
  return score < SHIFT_COVERAGE
    ? { isNew: true, reason: 'shift' }
    : { isNew: false, reason: 'continue' };
}

/* A title derived from the message that opened the topic. Truncation is by character count,
 * which is what a title is read as; the ellipsis marks that it was cut. */
function titleFromText(text) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!flat) return FALLBACK_TITLE;
  const stripped = flat.replace(/^[\p{P}\p{S}\s]+/u, '').replace(/[\p{P}\p{S}\s]+$/u, '');
  const s = stripped || flat;
  return s.length > TITLE_MAX_CHARS ? s.slice(0, TITLE_MAX_CHARS) + '…' : s;
}

module.exports = {
  contentTerms,
  coverage,
  decideBoundary,
  titleFromText,
  IDLE_GAP_MS,
  RECENT_WINDOW_MESSAGES,
  MIN_TERMS_TO_JUDGE,
  SHIFT_COVERAGE,
  IDLE_COVERAGE,
  TITLE_MAX_CHARS,
  FALLBACK_TITLE,
};
