import { defineConfig } from 'vite';
import { resolve }      from 'path';
import { fileURLToPath } from 'url';

// __dirname is not available in ES-module configs; derive it from import.meta.url
const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // ── Static assets ───────────────────────────────────────────────────────────
  // Everything in /public is served verbatim (raw-assets, sprites, textures, …)
  publicDir: 'public',

  // ── Multi-page mode ─────────────────────────────────────────────────────────
  // Disables the SPA HTML fallback so each entry point resolves independently.
  appType: 'mpa',

  // ── Build ───────────────────────────────────────────────────────────────────
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        lab:  resolve(__dirname, 'lab.html'),
      },
    },
  },

  // ── Dev server ──────────────────────────────────────────────────────────────
  server: {
    open: '/',   // open the main game on `vite dev`
  },

  // ── Plugins ─────────────────────────────────────────────────────────────────
  plugins: [
    {
      // Allow navigating to /lab (no extension) during development.
      // Vite resolves HTML entry points by filename; this middleware maps the
      // short URL to the real file before Vite's HTML transform runs.
      name: 'mpa-html-rewrites',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/lab' || req.url === '/lab/') {
            req.url = '/lab.html';
          }
          next();
        });
      },
    },
  ],
});
