/**
 * The whole suite.
 *
 *   npm run dev            # the tests drive the real dev server
 *   npm test               # everything
 *   npm test -- music      # one suite
 *   npm test -- --update   # re-record the golden frames
 *
 * Exits non-zero on any failure, so it can gate a commit or a build.
 */
const SUITES = {
  music: () => import('./music.mjs'),
  determinism: () => import('./determinism.mjs'),
  world: () => import('./world.mjs'),
  budgets: () => import('./budgets.mjs'),
  visual: () => import('./visual.mjs'),
};

const args = process.argv.slice(2);
const update = args.includes('--update');
const names = args.filter((a) => !a.startsWith('--'));
const chosen = names.length ? names : Object.keys(SUITES);

const bad = chosen.filter((n) => !SUITES[n]);
if (bad.length) {
  console.error(`unknown suite: ${bad.join(', ')}\navailable: ${Object.keys(SUITES).join(', ')}`);
  process.exit(2);
}

let failed = 0;
const t0 = Date.now();

for (const name of chosen) {
  const mod = await (SUITES[name])();
  process.stdout.write(`\n${name}\n`);
  let results;
  try {
    results = await mod.run({ update });
  } catch (e) {
    console.log(`  ERROR  ${e.message}`);
    failed++;
    continue;
  }
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`  ${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n${failed ? `${failed} failing` : 'all passing'} — ${secs}s`);
process.exit(failed ? 1 : 0);
