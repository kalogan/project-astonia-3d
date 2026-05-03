import { defineConfig } from 'vite';
import { resolve }      from 'path';
import { fileURLToPath } from 'url';
import fs               from 'fs';

// __dirname is not available in ES-module configs; derive it from import.meta.url
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// asset_tags.json lives in the project root alongside vite.config.js
const TAGS_FILE = resolve(__dirname, 'asset_tags.json');

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
        main:      resolve(__dirname, 'index.html'),
        lab:       resolve(__dirname, 'lab.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
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
      // GET  /api/tags         — return full asset_tags.json
      // POST /api/tags         — upsert one folder/file tag array and save
      name: 'tags-api',
      configureServer(server) {
        // Ensure the sidecar file exists
        function readTags() {
          try { return JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8')); }
          catch { return {}; }
        }
        function writeTags(data) {
          fs.writeFileSync(TAGS_FILE, JSON.stringify(data, null, 2), 'utf8');
        }

        server.middlewares.use((req, res, next) => {
          const { pathname } = new URL(req.url, 'http://localhost');
          if (pathname !== '/api/tags') return next();

          res.setHeader('Content-Type', 'application/json');

          if (req.method === 'GET') {
            res.end(JSON.stringify(readTags()));
            return;
          }

          if (req.method === 'POST') {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
              try {
                const { folderId, fileId, tags } = JSON.parse(body);
                if (!folderId || !fileId || !Array.isArray(tags))
                  throw new Error('payload must have folderId, fileId, tags[]');

                const db = readTags();
                if (!db[folderId]) db[folderId] = {};

                if (tags.length === 0) {
                  // Clean up empty entries to keep the file tidy
                  delete db[folderId][fileId];
                  if (Object.keys(db[folderId]).length === 0) delete db[folderId];
                } else {
                  db[folderId][fileId] = tags;
                }

                writeTags(db);
                res.end(JSON.stringify({ ok: true }));
              } catch (e) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: String(e) }));
              }
            });
            return;
          }

          next();
        });
      },
    },
    {
      // POST /api/find-asset — accept base64 PNG, run search_asset.py, return folder ID.
      name: 'find-asset-api',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== '/api/find-asset') {
            return next();
          }
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const { image } = JSON.parse(body);
              if (!image) throw new Error('missing image field');

              // Strip data-URL prefix if present
              const b64 = image.replace(/^data:image\/\w+;base64,/, '');
              const buf = Buffer.from(b64, 'base64');

              const os     = await import('os');
              const path   = await import('path');
              const fsP    = await import('fs/promises');
              const { exec } = await import('child_process');

              const tmpDir  = os.default.tmpdir();
              const tmpFile = path.default.join(tmpDir, `af_target_${Date.now()}.png`);
              await fsP.default.writeFile(tmpFile, buf);

              const assetsDir = resolve(__dirname, 'public/raw-assets');
              const script    = resolve(__dirname, 'search_asset.py');

              exec(`python "${script}" "${tmpFile}" "${assetsDir}"`, (err, stdout, stderr) => {
                fsP.default.unlink(tmpFile).catch(() => {});
                if (stderr) console.warn('[find-asset-api]', stderr.trim());
                res.setHeader('Content-Type', 'application/json');
                if (err) {
                  res.end(JSON.stringify({ result: 'NOT_FOUND' }));
                  return;
                }
                const raw = stdout.trim();
                try {
                  // On a match the script prints {"folder":"...","file":"..."}
                  const parsed = JSON.parse(raw);
                  res.end(JSON.stringify(parsed));
                } catch {
                  // NOT_FOUND or unexpected output
                  res.end(JSON.stringify({ result: raw || 'NOT_FOUND' }));
                }
              });
            } catch (e) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
        });
      },
    },
    {
      // POST /api/scan-region — accept base64 image + ROI, run reconstruct_map.py.
      name: 'scan-region-api',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== '/api/scan-region') {
            return next();
          }
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const { image, roi } = JSON.parse(body);
              if (!image || !roi) throw new Error('missing image or roi field');

              const b64 = image.replace(/^data:image\/\w+;base64,/, '');
              const buf = Buffer.from(b64, 'base64');

              const os     = await import('os');
              const path   = await import('path');
              const fsP    = await import('fs/promises');
              const { exec } = await import('child_process');

              const tmpDir  = os.default.tmpdir();
              const tmpFile = path.default.join(tmpDir, `sr_target_${Date.now()}.png`);
              await fsP.default.writeFile(tmpFile, buf);

              const script    = resolve(__dirname, 'reconstruct_map.py');
              const assetsDir = resolve(__dirname, 'public/raw-assets');
              const { startX, startY, width, height } = roi;
              const cmd = `python "${script}" "${tmpFile}" "${assetsDir}" ${startX} ${startY} ${width} ${height}`;

              exec(cmd, (err, stdout, stderr) => {
                fsP.default.unlink(tmpFile).catch(() => {});
                if (stderr) console.warn('[scan-region-api]', stderr.trim());
                res.setHeader('Content-Type', 'application/json');
                if (err) {
                  res.end(JSON.stringify({ status: 'error', error: err.message }));
                  return;
                }
                try {
                  res.end(JSON.stringify(JSON.parse(stdout.trim())));
                } catch {
                  res.end(JSON.stringify({ status: 'error', error: stdout.trim() || 'no output' }));
                }
              });
            } catch (e) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ status: 'error', error: String(e) }));
            }
          });
        });
      },
    },
    {
      // POST /api/save-map — receive a map payload and persist it under
      // public/maps/latest_map.json so the game engine can load it at runtime.
      name: 'save-map-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== '/api/save-map') {
            return next();
          }

          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              const payload = JSON.parse(body);

              const mapDir = resolve(__dirname, 'public/maps');
              if (!fs.existsSync(mapDir)) {
                fs.mkdirSync(mapDir, { recursive: true });
              }

              fs.writeFileSync(
                resolve(mapDir, 'latest_map.json'),
                JSON.stringify(payload, null, 2),
                'utf8'
              );

              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true }));
            } catch (e) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
        });
      },
    },
    {
      // Allow navigating to /lab (no extension) during development.
      // Vite resolves HTML entry points by filename; this middleware maps the
      // short URL to the real file before Vite's HTML transform runs.
      name: 'mpa-html-rewrites',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/lab'       || req.url === '/lab/')       req.url = '/lab.html';
          if (req.url === '/dashboard' || req.url === '/dashboard/') req.url = '/dashboard.html';
          next();
        });
      },
    },
    {
      // Scan public/hd-assets/ and expose its folder list + per-folder file
      // lists as JSON endpoints so the Lab can build its HD override index.
      name: 'hd-assets-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const { pathname } = new URL(req.url, 'http://localhost');

          if (pathname === '/api/get-hd-folders') {
            const hdDir = resolve(__dirname, 'public/hd-assets');
            let folders = [];
            try {
              folders = fs.readdirSync(hdDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
            } catch { /* hd-assets directory doesn't exist yet */ }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(folders));
            return;
          }

          const hdFilesMatch = pathname.match(/^\/api\/get-hd-files\/(.+)$/);
          if (hdFilesMatch) {
            const folder    = hdFilesMatch[1];
            const folderDir = resolve(__dirname, 'public/hd-assets', folder);
            let files = [];
            try {
              files = fs.readdirSync(folderDir)
                .filter(f => f.toLowerCase().endsWith('.png'))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            } catch { /* folder doesn't exist */ }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(files));
            return;
          }

          next();
        });
      },
    },
  ],
});
