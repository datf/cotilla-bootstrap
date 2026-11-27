import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { minify } from 'html-minifier-terser';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);

const minifyHtml = () => ({
  name: 'html-minifier',
  enforce: 'post',
  async transformIndexHtml(html) {
    return await minify(html, {
      collapseWhitespace: true,
      removeComments: true,
      removeRedundantAttributes: true,
      removeOptionalTags: true,
      minifyCSS: true,
      minifyJS: true,
    });
  },
});

let manifest = {};
const dir = typeof import.meta.dirname !== 'undefined' ? import.meta.dirname : path.dirname(new URL(import.meta.url).pathname);

function resolveWasmDir(rootDir) {
  const candidates = [];
  if (process.env.COTILLA_WASM_DIR) {
    candidates.push(path.resolve(rootDir, process.env.COTILLA_WASM_DIR));
  }
  candidates.push(path.resolve(rootDir, '../dist/wasm'));
  try {
    candidates.push(path.dirname(require.resolve('@datf/cotilla-wasm/package.json')));
  } catch {
    // Optional npm package fallback for standalone builds
  }
  candidates.push(rootDir);
  return candidates.find((d) => fs.existsSync(path.join(d, 'cotilla.wasm.gz')) || fs.existsSync(path.join(d, 'cotilla.wasm'))) || rootDir;
}

const VIRTUAL_WASM_ID = '\0cotilla-wasm-gzip';

const gzipWasmPlugin = (rootDir) => ({
  name: 'gzip-wasm',
  enforce: 'pre',
  resolveId(source) {
    if (source.includes('cotilla.wasm')) {
      return VIRTUAL_WASM_ID;
    }
  },
  load(id) {
    if (id === VIRTUAL_WASM_ID || id.includes('cotilla.wasm')) {
      const wasmDir = resolveWasmDir(rootDir);
      const gzPath = path.join(wasmDir, 'cotilla.wasm.gz');
      const rawPath = path.join(wasmDir, 'cotilla.wasm');
      let gzipped;
      if (fs.existsSync(gzPath)) {
        gzipped = fs.readFileSync(gzPath);
      } else if (fs.existsSync(rawPath)) {
        gzipped = zlib.gzipSync(fs.readFileSync(rawPath), { level: 9 });
      } else {
        throw new Error(`cotilla.wasm not found (checked COTILLA_WASM_DIR, ../dist/wasm, @datf/cotilla-wasm, ${rootDir})`);
      }
      const b64 = gzipped.toString('base64');
      const dataUri = `data:application/wasm;encoding=gzip;base64,${b64}`;
      return `export default ${JSON.stringify(dataUri)};`;
    }
  },
});

const defaultManifestPath = path.resolve(dir, '../dist/apps/cotilla-chat.manifest.json');
const customManifestPath = process.env.COTILLA_MANIFEST ? path.resolve(dir, process.env.COTILLA_MANIFEST) : null;
const manifestPath = (customManifestPath && fs.existsSync(customManifestPath)) ? customManifestPath : defaultManifestPath;
if (fs.existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    console.warn('[vite.config.js] failed to parse manifest:', err);
  }
}

const pinnedPubKey = process.env.COTILLA_PINNED_PUB_KEY || manifest.pub_key || '';
const appId = process.env.COTILLA_APP_ID || manifest.app_id || 'cotilla-chat';
const channel = process.env.COTILLA_CHANNEL || manifest.channel || 'stable';
const distRoomId = process.env.COTILLA_DIST_ROOM_ID || 'cotilla-app-dist-v1';
const signalingServer = process.env.COTILLA_SIGNALING_SERVER || 'localhost:8080';

export default defineConfig({
  assetsInclude: ['**/*.wasm'],
  plugins: [gzipWasmPlugin(dir), viteSingleFile(), minifyHtml()],
  define: {
    __PINNED_PUB_KEY__: JSON.stringify(pinnedPubKey),
    __APP_ID__: JSON.stringify(appId),
    __CHANNEL__: JSON.stringify(channel),
    __DIST_ROOM_ID__: JSON.stringify(distRoomId),
    __SIGNALING_SERVER__: JSON.stringify(signalingServer),
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 100_000_000,
  },
});
