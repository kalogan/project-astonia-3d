// scripts/compress.cjs
// Compresses every folder in public/raw-assets/ into a same-named .zip, then
// deletes the original folder. Also regenerates asset-manifest.json from the
// resulting zip files. Safe to re-run: folders already zipped are skipped.
// CJS (.cjs) because package.json has "type":"module".
'use strict';

const fs       = require('fs');
const path     = require('path');
const fse      = require('fs-extra');
const archiver = require('archiver');
const JSZip    = require('jszip');

const ASSETS_DIR   = path.join(__dirname, '..', 'public', 'raw-assets');
const MANIFEST_OUT = path.join(__dirname, '..', 'public', 'asset-manifest.json');

// ── Zip a folder's PNG files (no compression — PNGs are already compressed) ──
function zipFolder(folderPath, zipPath, pngFiles) {
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 0 } });  // STORE mode
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const fname of pngFiles) {
      archive.file(path.join(folderPath, fname), { name: fname });
    }
    archive.finalize();
  });
}

// ── Read filenames from a zip's central directory (no decompression) ──────────
async function readZipFileList(zipPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  return Object.keys(zip.files)
    .filter(n => !zip.files[n].dir && n.toLowerCase().endsWith('.png'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(ASSETS_DIR)) {
    console.error(`[compress] assets dir not found: ${ASSETS_DIR}`);
    process.exit(1);
  }

  const allEntries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
  const dirs       = allEntries.filter(e => e.isDirectory());
  const existingZips = allEntries.filter(e => !e.isDirectory() && e.name.endsWith('.zip'));

  // ── Fast path: nothing to compress and manifest already matches ────────────
  if (dirs.length === 0 && fs.existsSync(MANIFEST_OUT)) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_OUT, 'utf8'));
    if (Object.keys(manifest.folders ?? {}).length === existingZips.length) {
      console.log('[compress] nothing to do — all assets zipped, manifest current.');
      return;
    }
  }

  const folders = {};
  let   newZips = 0;

  // ── Step 1: compress any remaining uncompressed directories ───────────────
  for (const dir of dirs) {
    const folderPath = path.join(ASSETS_DIR, dir.name);
    const zipPath    = path.join(ASSETS_DIR, `${dir.name}.zip`);

    const pngFiles = fs.readdirSync(folderPath)
      .filter(f => f.toLowerCase().endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (pngFiles.length === 0) {
      await fse.remove(folderPath);
      continue;
    }

    if (!fs.existsSync(zipPath)) {
      process.stdout.write(`[compress] zipping ${dir.name} (${pngFiles.length} files)…`);
      await zipFolder(folderPath, zipPath, pngFiles);
      process.stdout.write(' done\n');
      newZips++;
    }

    // Remove original folder whether the zip was just created or pre-existed
    await fse.remove(folderPath);
    folders[dir.name] = pngFiles;
  }

  // ── Step 2: index pre-existing zip files ──────────────────────────────────
  const allZips = fs.readdirSync(ASSETS_DIR)
    .filter(f => f.endsWith('.zip'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  for (const zipName of allZips) {
    const folderName = path.basename(zipName, '.zip');
    if (folders[folderName]) continue;  // already handled in step 1

    process.stdout.write(`[compress] indexing ${zipName}…`);
    const files = await readZipFileList(path.join(ASSETS_DIR, zipName));
    folders[folderName] = files;
    process.stdout.write(` ${files.length} files\n`);
  }

  // ── Step 3: write asset-manifest.json ─────────────────────────────────────
  const totalFiles = Object.values(folders).reduce((s, f) => s + f.length, 0);
  fs.writeFileSync(MANIFEST_OUT, JSON.stringify({ folders }), 'utf8');

  console.log(
    `[compress] manifest written — ` +
    `${Object.keys(folders).length} zips · ${totalFiles.toLocaleString()} files` +
    (newZips ? ` · ${newZips} new zip(s) created` : '')
  );
}

main().catch(err => { console.error('[compress] Fatal:', err); process.exit(1); });
