'use strict';
/*
 * topics.js — when to *ask* whether the conversation has moved to a new subject.
 *
 * Pure policy: no database, no Electron, no network, no store import. conversation.js supplies
 * the recent text and acts on the answer.
 *
 * THIS MODULE NO LONGER DECIDES ANYTHING (ADR-012, revision 1). It proposes; a confirmation
 * decides. The reason is measured, not theoretical: the first real transcript was replayed
 * through the previous version, which decided on lexical evidence alone, and it split one
 * project into three topics. In that transcript a genuine change of subject and a continuation
 * of the same subject both scored a coverage of 0.000, and their term counts interleaved
 * (false splits at 15 and 21 terms, real splits at 17 and 19). No threshold separates those
 * cases, so no amount of tuning could have fixed it.
 *
 * That failure also showed why a false split is not merely untidy bookkeeping. With no history
 * attached, "中文分词你是怎么处理的" stopped meaning "how does your project handle Chinese
 * tokenization" and became "how do *you* tokenize" — she answered about herself. The split
 * changed what the user's sentence meant.
 *
 * Consequences for the numbers below: because a proposal is now filtered by something that can
 * read meaning, this module is tuned for RECALL rather than precision. It proposes readily and
 * accepts that some proposals are a wasted request; a proposal that is wrong costs one small
 * call, while a proposal that is missing costs a subject that never gets its own topic.
 *
 * Coverage is measured on CJK bigrams, not on the single characters the FTS index uses
 * (store.tokenizeForIndex). Single characters overlap almost everywhere — 的, 我, 不 appear in
 * unrelated sentences — so they would report continuity between subjects that share nothing.
 */

/* All of these are guesses that the evaluation corpus in docs/eval/ is meant to correct. They
 * are named and exported for that reason, not because they are known to be right. */

/* A gap this long means "a new sitting", not "a new sentence". */
const IDLE_GAP_MS = 6 * 60 * 60 * 1000;

/* How many of the current topic's newest messages count as "the current subject". */
const RECENT_WINDOW_MESSAGES = 8;

/*
 * A message carrying fewer content terms than this is not worth a request. Interjections
 * ("嗯", "为什么？", "哈哈哈") and bare greetings sit below it, and asking about them would spend a
 * call to answer a question whose answer is obvious.
 *
 * Lowered 5 -> 3 by production evidence: "上学好烦啊" carries four terms and is plainly a change
 * of subject, and at 5 it was never asked about at all.
 */
const MIN_PROPOSAL_TERMS = 3;

/*
 * One shared term is a coincidence, not a shared subject.
 *
 * This is the rule the first production run was missing. "附近有什么好吃的？" (6 terms) shared
 * exactly one term with its topic — 「有什」, a bigram spanning 有|什么, matched against the
 * greeting's 「有什么事？」 — which came to 0.167 coverage, just over the bar below. A change of
 * subject was suppressed by two characters that mean nothing together.
 *
 * So a message is only treated as plainly on-topic when it shares at least two content terms
 * AND a high enough share of its own. Anything less is asked about, which is affordable; being
 * silently wrong is not.
 */
const MIN_SHARED_TERMS = 2;

/*
 * Share of the message's content terms that must already be on-topic, together with
 * MIN_SHARED_TERMS, for it to pass without asking. Measured against the replayed transcripts:
 * the genuine changes of subject scored 0.000, while the one continuation that stays cheap
 * scored 0.333.
 */
const PROPOSE_COVERAGE = 0.15;

/*
 * After a long gap the same test is applied with a lower bar, because a new sitting is weaker
 * evidence about the subject than a new sentence in the middle of one.
 */
const IDLE_COVERAGE = 0.35;

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

/* How many of the message's distinct content terms also appear in the topic's recent text.
 * Exposed because one shared term is the unit that decides whether a question gets asked. */
function sharedCount(newTerms, recentTerms) {
  const recent = new Set(recentTerms);
  let hit = 0;
  for (const term of new Set(newTerms)) if (recent.has(term)) hit++;
  return hit;
}

/*
 * How much of the new message is already on-topic: the share of its distinct content terms
 * that also appear in the current subject's recent text. A message with no content terms at
 * all returns 1 — "no evidence of change" must not read as "change".
 */
function coverage(newTerms, recentTerms) {
  const unique = new Set(newTerms);
  if (!unique.size) return 1;
  return sharedCount(unique, recentTerms) / unique.size;
}

/*
 * Should this message be put to the confirmer?
 *
 * input: { hasTopic, lastMessageAt, now, text, recentTexts }
 *   hasTopic      — is there a current topic to continue?
 *   lastMessageAt — when the newest message of that topic was written (0 if none)
 *   now           — wall clock, injected so tests do not have to wait six hours
 *   recentTexts   — the current topic's newest messages, oldest first
 *
 * Returns { propose, reason }, where reason is 'first' | 'idle' | 'shift' | 'continue'.
 * `propose` means "ask"; it does not mean "split". A false answer here costs one request, and
 * `reason` is what that request is explained by when reading a log or a failing case.
 */
function proposeBoundary(input) {
  const opts = input || {};
  if (!opts.hasTopic) return { propose: false, reason: 'first' };

  const unique = new Set(contentTerms(opts.text));
  if (unique.size < MIN_PROPOSAL_TERMS) return { propose: false, reason: 'continue' };

  const recentTerms = contentTerms((opts.recentTexts || []).join('\n'));
  const shared = sharedCount(unique, recentTerms);
  const score = shared / unique.size;
  const plainlyOnTopic = shared >= MIN_SHARED_TERMS && score >= PROPOSE_COVERAGE;

  const idle = Boolean(opts.lastMessageAt) && opts.now - opts.lastMessageAt >= IDLE_GAP_MS;
  if (idle) {
    const stillOnTopic = shared >= MIN_SHARED_TERMS && score >= IDLE_COVERAGE;
    return stillOnTopic
      ? { propose: false, reason: 'continue' }
      : { propose: true, reason: 'idle' };
  }
  return plainlyOnTopic
    ? { propose: false, reason: 'continue' }
    : { propose: true, reason: 'shift' };
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
  sharedCount,
  proposeBoundary,
  titleFromText,
  IDLE_GAP_MS,
  RECENT_WINDOW_MESSAGES,
  MIN_PROPOSAL_TERMS,
  MIN_SHARED_TERMS,
  PROPOSE_COVERAGE,
  IDLE_COVERAGE,
  TITLE_MAX_CHARS,
  FALLBACK_TITLE,
};
