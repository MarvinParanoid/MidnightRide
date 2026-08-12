/**
 * Builds the itch.io upload: a zip with index.html at its root and every asset
 * referenced relatively.
 *
 *   npm run build:itch
 *
 * Then on itch: Kind of project → HTML, upload the zip, tick "This file will be
 * played in the browser", and set the viewport (960×540 works; also tick the
 * fullscreen button). Nothing else to configure — there is no backend.
 */
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = 'dist-itch';
const ZIP = 'midnight-ride-itch.zip';

process.env.MR_TARGET = 'itch';
/* Vite empties the directory itself. Deleting it outright yanks the ground out
   from under any shell sitting in it — which is exactly where you end up after
   serving the build for a stream. */
rmSync(ZIP, { force: true });

await build();

/* index.html has to be at the root of the zip, not inside a folder — itch
   serves whatever sits next to it and will not go looking one level down. */
if (!existsSync(resolve(OUT, 'index.html'))) {
  console.error(`no index.html in ${OUT}/ — itch will not know what to serve`);
  process.exit(1);
}

try {
  execFileSync('zip', ['-r', '-q', '-9', resolve(ZIP), '.'], { cwd: OUT, stdio: 'inherit' });
} catch {
  console.error('could not run `zip` — zip up the contents of ' + OUT + '/ yourself,');
  console.error('making sure index.html ends up at the top level of the archive.');
  process.exit(1);
}

const mb = (statSync(ZIP).size / 1048576).toFixed(2);
console.log(`\n${ZIP}  ${mb} MB`);
console.log('contents:', readdirSync(OUT).join(', '));
console.log('\nupload it as an HTML project, tick "played in the browser", viewport 960×540.');
