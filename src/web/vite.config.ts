// Builds the page app into build/web: app/barkley.js and app/barkley.css (from src/), and public/ as it is (sw.js at the
// root, the font in app/). src/offline.mjs copies that folder over an Igor build, and index.html loads it.
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: '../../build/web',
    emptyOutDir: true,
    target: 'es2022',
    // Readable in a deployed build, as the extension shims were: the quickest way to tell a stale page from a bug.
    // It is tens of kilobytes beside a 7 MB game.
    minify: false,
    cssCodeSplit: false,
    rolldownOptions: {
      input: 'src/main.tsx',
      output: {
        // A classic script, not a module: it has to run before the game's own script, which captures
        // requestAnimationFrame as it loads, and a module would run after it.
        format: 'iife',
        // Strict, so the runtime's error trace (it walks arguments.callee.caller) stops cleanly at the page's
        // functions instead of throwing on them.
        strict: true,
        entryFileNames: 'app/barkley.js',
        assetFileNames: (asset) => (asset.names[0]?.endsWith('.css') ? 'app/barkley.css' : 'app/[name][extname]'),
      },
    },
  },
});
