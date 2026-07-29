import { defineConfig } from 'vite';

/**
 * The build, which the game now has because the UI is built out of component folders:
 * every one of them is an `.html` template, an `.scss` sheet and a `.ts` class, and the
 * `?raw`/`?inline` imports that pull the first two into the third are what make a component
 * self-contained without fetching three files at runtime.
 *
 * Output is plain ES modules in `dist/`, which is what `server/index.js` serves.
 */
export default defineConfig({
  // Relative asset URLs, so the built game does not care whether it is served from the
  // root or from a subpath behind somebody's reverse proxy.
  base: './',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Every browser that can run the game can run custom elements, `adoptedStyleSheets`
    // and top-level await. Transpiling below that buys nothing and costs legibility in
    // the output, which is the one place a build step should stay readable.
    target: 'es2022',
    // The game is ~7k lines and loads once. A source map costs nothing at runtime and is
    // the difference between debugging the game and debugging the bundle.
    sourcemap: true,
  },

  server: {
    port: 5173,
    // `npm run dev` serves the game; the pool still lives on the Node server, and the
    // client calls `/api/...` same-origin. Without this the dev server answers those
    // itself with its index.html and every par lookup fails on a JSON parse.
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: false,
      },
    },
  },
});
