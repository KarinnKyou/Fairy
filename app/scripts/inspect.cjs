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
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP = path.resolve(__dirname, '..');
const store = require(path.join(APP, 'store.js'));
const conversation = require(path.join(APP, 'conversation.js'));
const personality = require(path.join(APP, 'personality.js'));

function parseArgs(argv) {
  const out = { dir: null, dev: false, prompt: false, limit: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--dev') out.dev = true;
    else if (a === '--prompt') out.prompt = true;
    else if (a === '--limit') out.limit = Number(argv[++i]) || 40;
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

const rows = store.recentMessages(opened.db, args.limit);
console.log('\n--- transcript (oldest first) ---');
if (!rows.length) console.log('(empty)');
for (const m of rows) {
  const when = new Date(m.createdAt).toLocaleTimeString();
  /* For replies, show what was actually sent to the model. A reply that ignores the
   * question is usually a context problem, and this is where that shows up. */
  let ctx = '';
  if (m.role === 'assistant') {
    ctx = m.contextMessages == null
      ? '  [context: unknown]'
      : '  [context: ' + m.contextMessages + ' msg, system ' + m.promptChars + ' ch]';
  }
  console.log('[' + when + '] ' + m.role.padEnd(9) + ' ' + String(m.content).replace(/\n/g, ' \\n ') + ctx);
}

/* What the next turn would send. Optional because it re-runs the example picker. */
if (args.prompt) {
  const msgs = conversation.buildMessages({
    persona: personality.PERSONA,
    examples: personality.EXAMPLES,
    identity,
    history: rows,
    pickExample: (pool) => pool[0],
    now: Date.now(),
  });
  console.log('\n--- prompt that the next message would send (' + msgs.length + ' messages) ---');
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
