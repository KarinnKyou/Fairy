'use strict';
/*
 * api.js — the two requests to the model that are not the reply itself.
 *
 * Why this module exists at all: `main.js` cannot be loaded outside Electron, so anything left
 * there has no test coverage and cannot be exercised without opening a window. The topic
 * confirmation and the memory extraction are pure request-and-parse functions — they need a key and
 * a network, not an Electron app — so they live here, where a test can call them and a headless
 * script can run them against the real API.
 *
 * The streaming chat request stays in main.js on purpose: it is wound through IPC events and a
 * window, which is exactly the part that is *not* separable.
 *
 * Both functions answer a question with a small JSON object and are read defensively. Every failure
 * returns null or nothing, and null means "the model did not answer" — never a default that would
 * let an unreachable model invent a topic boundary or a fact about the owner.
 */

/* The classifier is on the critical path of a turn: the reply waits for it, so it gets a short
 * leash. The extractor runs after the reply is already on screen, so it can afford longer. */
const CONFIRM_TIMEOUT_MS = 8000;
const EXTRACT_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ topic boundary */

/*
 * The question asked when the local rule proposes a boundary, and the name it comes back with.
 * Every constraint here exists because of a real failure:
 *   - a name is required on both answers, because a session that opens with a greeting otherwise
 *     keeps a truncated sentence as its title;
 *   - it asks whether the subject is still the same even when the project is being discussed from
 *     another angle, because that is the case the local rule cannot see (ADR-012).
 */
function boundaryPrompt(input) {
  const transcript = (input.recent || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => (m.role === 'user' ? '主人：' : '你：') + m.content)
    .join('\n');

  return {
    system: [
      '你是话题切分器。判断主人这条新消息是否仍在延续当前话题，并给话题起名字。',
      '只输出一个 JSON 对象，不要输出解释、不要加代码块。',
      '格式：{"same": true|false, "title": "..."}',
      'title 始终要给出，是 4 到 12 个字的名词短语，概括话题主题',
      '（例如「终端项目的全文搜索」「科幻电影推荐」），不要照抄原句、不要带标点和引号。',
      'same 为 true 表示延续当前话题，此时 title 是当前话题的名字（当前名字已经合适就原样返回）。',
      'same 为 false 表示换了新话题，此时 title 是新话题的名字。',
      '判断标准：即使在讨论同一个项目的不同方面，只要仍在谈同一件事，就算 same。',
    ].join('\n'),
    user: '当前话题：' + input.topic.title + '\n' +
      (transcript ? '最近的对话：\n' + transcript + '\n' : '') +
      '新消息：' + input.text,
  };
}

/*
 * Read the verdict out of whatever came back. Models wrap JSON in prose or code fences, and a
 * classifier that cannot be parsed is the same as one that was never asked, so this returns null
 * rather than guessing a default.
 */
function parseBoundaryVerdict(text) {
  const s = String(text == null ? '' : text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed.same !== 'boolean') return null;
  return {
    isNew: !parsed.same,
    title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
  };
}

/* ------------------------------------------------------------------ memory extraction */

/*
 * The question asked when the local rule decides a turn is worth it.
 *
 * Two instructions carry real weight. `replaces` is what turns a correction into a supersession
 * instead of a duplicate, and it is the reason the currently believed memories are sent along. And
 * the ban on vague time words comes from watching the first real memory the app ever stored:
 * 「主人最近在写一个名为 HDD 的新项目」. A memory has no expiry, so "recently" silently becomes a
 * false statement — and nothing in the app will ever notice.
 */
function extractionPrompt(input) {
  const existing = (input.existing || []).length
    ? input.existing.map((m) => '- ' + m.id + ' :: ' + m.text).join('\n')
    : '(还没有任何记忆)';

  return {
    system: [
      '你负责从对话中提取关于主人的长期事实，供以后回忆时使用。',
      '只输出一个 JSON 对象，不要解释、不要加代码块。',
      '格式：{"memories":[{"text":"...","replaces":"<已有记忆的 id，可省略>"}]}',
      '只提取关于主人的稳定事实：身份、住处、工作或学业、长期偏好、习惯、重要关系、长期目标。',
      '不要提取：一次性的请求或情绪、临时状态、助手自己的情况、以及你没有把握的内容。',
      '每条一句话，用第三人称陈述，例如「主人在做 HDD 终端项目」「主人住在杭州」。',
      '不要用「最近」「这几天」「目前」这类模糊的时间词：记忆没有有效期，它们会悄悄变成假话。',
      '如果时间本身就是事实的一部分，就写具体时间（例如「主人从 2023 年开始学 Rust」）。',
      '如果新信息更新或纠正了某条已有记忆，把 replaces 填成那条记忆的 id，不要新增重复的一条。',
      '没有值得长期记住的内容时，返回 {"memories":[]}。',
    ].join('\n'),
    user: '已有记忆：\n' + existing + '\n\n这一轮对话：\n主人：' + input.userText +
      (input.assistantText ? '\n你：' + input.assistantText : ''),
  };
}

/* ------------------------------------------------------------------ the requests */

/*
 * A single non-streaming request. Returns the message content, or null for every failure — a
 * missing key, a bad status, a timeout, a network error. The caller decides what null means; for
 * both of these it means "no answer", which is never the same as "no" and never a default.
 */
async function askOnce(config, prompt, maxTokens, timeoutMs) {
  if (!config || !config.apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(String(config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') +
      '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        stream: false,
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content) || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/*
 * Wrap the two questions into the callbacks conversation.js expects.
 *
 * `onError` is how a failure becomes visible: an unreachable classifier looks exactly like a
 * conversation that never changes subject, so silence is the one outcome that must not happen
 * quietly.
 *
 * `raw` is passed through on the returned object for the headless probe: it needs to show what the
 * model actually said, not only what was made of it.
 */
function createApi(config, options) {
  const opts = options || {};
  const report = typeof opts.report === 'function' ? opts.report : null;

  async function confirmBoundary(input) {
    const prompt = boundaryPrompt(input);
    const started = Date.now();
    const raw = await askOnce(config, prompt, 80, CONFIRM_TIMEOUT_MS);
    const verdict = parseBoundaryVerdict(raw);
    /* `ms` is reported because the latency of this request is a cost the user feels: the reply
     * waits for it. The extractor's does not, which is why the two are told apart. */
    if (report) report({ kind: 'boundary', prompt, raw, verdict, ms: Date.now() - started });
    return verdict;
  }

  async function extractMemories(input) {
    const prompt = extractionPrompt(input);
    const started = Date.now();
    const raw = await askOnce(config, prompt, 500, EXTRACT_TIMEOUT_MS);
    if (report) report({ kind: 'memory', prompt, raw, verdict: raw, ms: Date.now() - started });
    return raw;
  }

  return { confirmBoundary, extractMemories };
}

module.exports = {
  createApi,
  boundaryPrompt,
  parseBoundaryVerdict,
  extractionPrompt,
  askOnce,
  CONFIRM_TIMEOUT_MS,
  EXTRACT_TIMEOUT_MS,
};
