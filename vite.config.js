// On GitHub Pages the site lives at /MidnightRide/, so the build needs that
// prefix; the dev server stays at the root where it is easier to work with.
export default ({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/MidnightRide/' : '/',
  server: { host: '127.0.0.1', port: 5173, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
