/**
 * Three targets, and they differ only in where the page thinks it lives:
 *
 *   dev      served from the root, so localhost URLs stay short
 *   pages    lives at /MidnightRide/ on github.io
 *   itch     served from a generated path like html-classic.itch.zone/html/<id>/,
 *            which nobody knows at build time — so the paths must be relative
 *
 * Get this wrong and the page loads to a blank screen with a 404 for the
 * bundle, which is exactly what it looks like when the game itself is broken.
 */
const itch = process.env.MR_TARGET === 'itch';

export default ({ command, isPreview }) => ({
  base: itch ? './' : command === 'build' || isPreview ? '/MidnightRide/' : '/',
  server: { host: '127.0.0.1', port: 5173, open: false },
  build: {
    target: 'es2022',
    outDir: itch ? 'dist-itch' : 'dist',
    chunkSizeWarningLimit: 2000,
  },
});
