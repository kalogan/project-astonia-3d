// scripts/gen-manifest.cjs
// Scans public/raw-assets/ and writes public/asset-manifest.json.
// Runs as a prebuild / predev hook so the manifest is always fresh before Vite starts.
// CommonJS (.cjs) because package.json has "type":"module".
'use strict';

const fs   = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'public', 'raw-assets');
const OUT_FILE   = path.join(__dirname, '..', 'public', 'asset-manifest.json');

if (!fs.existsSync(ASSETS_DIR)) {
  console.error(`[gen-manifest] ASSETS_DIR not found: ${ASSETS_DIR}`);
  process.exit(1);
}

const folders    = {};
let   totalFiles = 0;

const dirEntries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });

for (const entry of dirEntries) {
  if (!entry.isDirectory()) continue;

  const folderPath = path.join(ASSETS_DIR, entry.name);
  const files = fs.readdirSync(folderPath)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) continue;

  folders[entry.name] = files;
  totalFiles += files.length;
}

fs.writeFileSync(OUT_FILE, JSON.stringify({ folders }), 'utf8');

console.log(
  `[gen-manifest] ${Object.keys(folders).length} folders · ` +
  `${totalFiles.toLocaleString()} files → ${path.relative(process.cwd(), OUT_FILE)}`
);
