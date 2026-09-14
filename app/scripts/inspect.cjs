'use strict';
/*
 * inspect.cjs — print what the store holds and what would be sent to the model.
 *
 * This is the audit tool ADR-002 promised: the database is binary, so there has to be a
 * one-command way to see the data and, more importantly, to see the exact prompt that goes
 * out. When a reply looks wrong, run this before guessing.
 *
 *   node scripts/inspect.cjs                       # the real store (app/data)
 *   node scripts/inspect.cjs --dir <path>          # a specific store
 *   node scripts/inspect.cjs --dev                 # the scratch store used by npm run dev
 *   node scripts/inspect.cjs --dev --prompt        # also print the prompt for the next turn
 *   node scripts/inspect.cjs --topic 2             # only one topic's messages (index or id)
 *
 * With topics (Phase 2) the interesting question changed: not only "what is stored" but
 * "which topic is this in, and what does the next turn actually see" — a topic boundary in
 * the wrong place looks fine on screen and wrong in the prompt.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const store = require(path.join(APP, 'store.js'));
const conversation = require(path.join(APP, 'conversation.js'));
const personality = require(path.join(APP, 'personality.js'));

function parseArgs(argv) {
  const out = { dir: null, dev: false, prompt: false, limit: 40, topic: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--dev') out.dev = true;
    else if (a === '--prompt') out.prompt = true;
    else if (a === '--limit') out.limit = Number(argv[++i]) || 40;
    else if (a === '--topic') out.topic = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dir = args.dir || (args.dev ? path.join(os.tmpdir(), 'hdd-dev-data') : path.join(APP, 'data'));

console.log('store directory : ' + dir);
if (!fs.existsSync(path.join(dir, 'hdd.db'))) {
  console.log('state           : NO DATABASE YET (nothing has been stored here)');
  process.exit(0);
}

const opened = store.open({ dir });
console.log('schema version  : v' + opened.schemaVersion);

const identity = store.ensureIdentity(opened.db);
console.log('first_seen      : ' + (identity.firstSeen ? new Date(identity.firstSeen).toLocaleString() : '(never)'));
console.log('turns (finished): ' + identity.turns);
console.log('last_seen       : ' + (store.metaGet(opened.db, 'last_seen') ? new Date(Number(store.metaGet(opened.db, 'last_seen'))).toLocaleString() : '(never)'));
console.log('messages stored : ' + store.countMessages(opened.db));

/* ---------------------------------------------------------------- topics */
const topicList = store.listTopics(opened.db);
const current = store.getCurrentTopic(opened.db);
console.log('topics          : ' + topicList.length);

/* The number printed on the left is what --topic accepts, and what the transcript refers to. */
console.log('\n--- topics (newest activity first) ---');
if (!topicList.length) console.log('(none)');
for (let i = 0; i < topicList.length; i++) {
  const t = topicList[i];
  const isCurrent = current && current.id === t.id;
  console.log('  ' + (i + 1) + '. ' + t.title +
    '   [' + t.messageCount + ' msg, last ' + new Date(t.updatedAt).toLocaleString() + ']' +
    (isCurrent ? '   <- current' : ''));
  /* The raw id matters when a topic has to be referenced by --topic or repaired by hand. */
  if (isCurrent || args.topic) console.log('       id: ' + t.id);
}

/* `--topic` takes the index printed above or an id prefix. */
function resolveTopic(arg) {
  if (!arg) return null;
  if (/^\d+$/.test(arg)) return topicList[Number(arg) - 1] || null;
  const hits = topicList.filter((t) => t.id.indexOf(arg) === 0);
  return hits.length === 1 ? hits[0] : null;
}
let selected = null;
if (args.topic) {
  selected = resolveTopic(args.topic);
  if (!selected) {
    console.log('\n(no such topic: ' + args.topic + ')');
    store.close(opened);
    process.exit(2);
  }
}

const topicIndex = new Map(topicList.map((t, i) => [t.id, i + 1]));
const rows = selected
  ? store.recentMessages(opened.db, args.limit, { topicId: selected.id })
  : store.recentMessages(opened.db, args.limit);

console.log('\n--- transcript (oldest first' + (selected ? ', topic ' + args.topic : '') + ') ---');
if (!rows.length) console.log('(empty)');
for (const m of rows) {
  const when = new Date(m.createdAt).toLocaleTimeString();
  /* Which topic a message landed in is the thing that is invisible on screen and decides what
   * the next turn is reminded of. */
  const tag = m.topicId && topicIndex.has(m.topicId) ? '#' + topicIndex.get(m.topicId) : '#?';
  /* For replies, show what was actually sent to the model. A reply that ignores the
   * question is usually a context problem, and this is where that shows up. */
  let ctx = '';
  if (m.role === 'assistant') {
    ctx = m.contextMessages == null
      ? '  [context: unknown]'
      : '  [context: ' + m.contextMessages + ' msg, system ' + m.promptChars + ' ch]';
  }
  console.log('[' + when + '] ' + tag + ' ' + m.role.padEnd(9) + ' ' + String(m.content).replace(/\n/g, ' \\n ') + ctx);
}

/* What the next turn would send. Optional because it re-runs the example picker.
 * Scoped to the topic that is in progress, because that is what the app would assemble now:
 * printing the global window here would describe a prompt that never goes out. */
if (args.prompt) {
  const history = current
    ? store.recentMessages(opened.db, conversation.CONTEXT_MESSAGE_LIMIT, { topicId: current.id })
    : [];
  const msgs = conversation.buildMessages({
    persona: personality.PERSONA,
    examples: personality.EXAMPLES,
    identity,
    history,
    pickExample: (pool) => pool[0],
    now: Date.now(),
  });
  console.log('\n--- prompt that the next message would send (' + msgs.length + ' messages' +
    (current ? ', topic "' + current.title + '"' : '') + ') ---');
  msgs.forEach((m, i) => {
    const head = '[' + i + '] ' + m.role.toUpperCase();
    if (m.role === 'system') {
      console.log(head + ' (' + m.content.length + ' chars)');
      console.log(m.content.split('\n').map((l) => '    | ' + l).join('\n'));
    } else {
      console.log(head + '  ' + String(m.content).replace(/\n/g, ' \\n ').slice(0, 200));
    }
  });
} else {
  console.log('\n(tip: add --prompt to print the exact messages the next turn would send)');
}

store.close(opened);
