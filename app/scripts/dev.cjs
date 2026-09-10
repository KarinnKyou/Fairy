'use strict';
/*
 * dev.cjs — run HDD against a scratch data directory.
 *
 * Why this exists: while developing you open the app constantly and ask the same test
 * questions over and over. Without this, every throwaway question ends up in the real
 * store, mixed in with conversations you actually care about, and the profile facts
 * ("第 N 轮对话", "首次见面") become meaningless.
 *
 * So the app supports HDD_DATA_DIR, and this launcher points it at a scratch directory:
 *
 *   node scripts/dev.cjs            keep the scratch store between runs (test continuity)
 *   node scripts/dev.cjs --fresh    wipe it first (clean-slate testing)
 *   node scripts/dev.cjs --dir X    use a specific directory
 *
 * The real store in app/data is never touched by this path.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const APP = path.resolve(__dirname, '..');
const store = require(path.join(APP, 'store.js'));

const DEFAULT_SCRATCH = path.join(os.tmpdir(), 'hdd-dev-data');

function parseArgs(argv) {
  const out = { fresh: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fresh') out.fresh = true;
    else if (a === '--dir') { out.dir = argv[++i]; }
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log('usage: node scripts/dev.cjs [--fresh] [--dir <path>]');
  process.exit(0);
}

const scratch = args.dir ? path.resolve(args.dir) : DEFAULT_SCRATCH;
fs.mkdirSync(scratch, { recursive: true });

/* --fresh: remove only the store files, never the directory itself (it may be shared). */
if (args.fresh) {
  const removed = store.resetDataDir(scratch, { force: true });
  console.log('dev: cleared ' + removed + ' file(s) in ' + scratch);
}

const electron = require('electron');

console.log('dev: scratch store -> ' + scratch);
console.log('dev: the real store in app/data is untouched');
if (!args.fresh) console.log('dev: use --fresh for a clean slate');

/* stdio is inherited rather than piped: piping a child\'s output is blocked in some
 * sandboxed environments, and the app window is interactive anyway. */
const result = spawnSync(electron, [APP], {
  stdio: 'inherit',
  env: Object.assign({}, process.env, { HDD_DATA_DIR: scratch }),
});

if (result.error) {
  console.error('dev: failed to start Electron: ' + result.error.message);
  process.exit(1);
}
process.exit(result.status == null ? 0 : result.status);
