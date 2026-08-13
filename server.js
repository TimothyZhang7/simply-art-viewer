// Simply Art Viewer — standalone gallery server.
// Zero-framework Node http server: scans a configured root into collections,
// serves originals with Range support, and cached webp thumbnails.
//
// Usage: node server.js [rootPath] [--port N] [--host H]

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { stat, readdir, readFile, writeFile } from 'node:fs/promises';
import { scanLibrary, fromId, naturalCompare } from './lib/scanner.js';
import { ThumbService, snapWidth } from './lib/thumbs.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
// Desktop builds run from a read-only package — config and caches go to a
// writable data dir (SAV_DATA_DIR) instead, defaulting to the app folder.
const DATA_DIR = process.env.SAV_DATA_DIR || APP_DIR;
const CACHE_DIR = path.join(DATA_DIR, '.savcache');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
};

// ---------------------------------------------------------------- config

const DEFAULT_CONFIG = { rootPath: '', port: 4877, host: '127.0.0.1', minImages: 2 };

async function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

const config = await loadConfig();
// Inside the desktop shell argv belongs to Electron/Chromium (launcher
// switches, file associations) — parsing it would misread stray args as a
// library path, so CLI overrides are dev-server only.
if (!process.env.SAV_DESKTOP) {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--port') config.port = Number(process.argv[++i]) || config.port;
    else if (a === '--host') config.host = process.argv[++i] || config.host;
    else if (!a.startsWith('--')) config.rootPath = a;
  }
}
// The desktop shell passes 0 for an ephemeral port (the --port flag can't:
// `Number(v) ||` treats 0 as unset).
if (process.env.SAV_PORT !== undefined) config.port = Number(process.env.SAV_PORT) || 0;

async function persistConfig() {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------- library state

const thumbs = new ThumbService(CACHE_DIR);
const library = {
  collections: [],
  byId: new Map(),
  stats: null,
  error: null,
  scanning: false,
  scanPromise: null,
  queued: false,
  progress: null,
};

async function scanOnce() {
  // Reads config at call time, so a queued follow-up scan picks up root changes.
  try {
    if (!config.rootPath) {
      library.collections = [];
      library.byId = new Map();
      library.stats = null;
      library.error = null;
      return;
    }
    library.progress = { phase: 'walk', dirs: 0, files: 0 };
    const { collections, stats } = await scanLibrary(config.rootPath, {
      minImages: config.minImages,
      cacheDir: CACHE_DIR,
      onProgress: (p) => { library.progress = p; },
    });
    library.collections = collections;
    library.byId = new Map(collections.map((c) => [c.id, c]));
    library.stats = stats;
    library.error = null;
  } catch (err) {
    library.collections = [];
    library.byId = new Map();
    library.stats = null;
    library.error = err.message ?? String(err);
  }
}

function rescan() {
  // Joining an in-flight scan would miss config changes made after it started,
  // so a rescan requested mid-scan queues one follow-up pass.
  if (library.scanPromise) {
    library.queued = true;
    return library.scanPromise;
  }
  library.scanning = true;
  library.scanPromise = (async () => {
    do {
      library.queued = false;
      await scanOnce();
    } while (library.queued);
    library.scanning = false;
    library.scanPromise = null;
  })();
  return library.scanPromise;
}

// Resolve a media id back to an absolute path, guarded against traversal.
function resolveMedia(id) {
  let rel;
  try {
    rel = fromId(id);
  } catch {
    return null;
  }
  if (!rel || rel.includes('\0')) return null;
  const root = path.resolve(config.rootPath);
  const abs = path.resolve(root, ...rel.split('/'));
  // Drive roots resolve with a trailing separator ("D:\"), so build the
  // child prefix instead of blindly appending another separator.
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(prefix)) return null;
  return abs;
}

// ---------------------------------------------------------------- http helpers

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (c) => {
      if (overflow) return;
      size += c.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        const err = new Error('payload too large');
        err.status = 413;
        reject(err);
        req.resume(); // drain so the 413 can still be delivered
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!overflow) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

async function streamFile(req, res, absPath, { immutable = false } = {}) {
  let st;
  try {
    st = await stat(absPath);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const ext = path.extname(absPath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };

  const range = req.headers.range;
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        start = Math.max(0, st.size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || end < start) {
    res.end(); // HEAD, or an empty file (createReadStream rejects end=-1)
    return;
  }
  const stream = createReadStream(absPath, { start, end });
  // pipeline (unlike pipe) destroys the read stream when the client aborts,
  // so aborted range requests don't leak file descriptors.
  pipeline(stream, res, () => {});
}

function libraryPayload() {
  return {
    config: { rootPath: config.rootPath, minImages: config.minImages },
    scanning: library.scanning,
    stats: library.stats,
    error: library.error,
    collections: library.collections.map((c) => ({
      id: c.id,
      name: c.name,
      rel: c.rel,
      imageCount: c.imageCount,
      videoCount: c.videoCount,
      cover: c.cover ? { id: c.cover.id, v: c.cover.v, w: c.cover.w, h: c.cover.h } : null,
    })),
  };
}

// ---------------------------------------------------------------- routing

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/collections' && req.method === 'GET') {
    if (library.scanPromise) await library.scanPromise;
    return sendJson(res, 200, libraryPayload());
  }

  if (p === '/api/collection' && req.method === 'GET') {
    if (library.scanPromise) await library.scanPromise;
    const c = library.byId.get(url.searchParams.get('id'));
    if (!c) return sendJson(res, 404, { error: 'collection not found' });
    return sendJson(res, 200, {
      id: c.id,
      name: c.name,
      rel: c.rel,
      items: c.items.map((it) => ({
        id: it.id, name: it.name, type: it.type, w: it.w, h: it.h, v: it.v,
      })),
    });
  }

  if (p === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { rootPath: config.rootPath, minImages: config.minImages });
  }

  // Non-blocking scan status — pollable while a scan is running (the other
  // /api endpoints intentionally await the scan before answering).
  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      scanning: library.scanning,
      progress: library.progress,
      stats: library.stats,
      error: library.error,
      config: { rootPath: config.rootPath, minImages: config.minImages },
    });
  }

  if (p === '/api/config' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch (err) {
      return sendJson(res, err.status ?? 400, { error: err.status ? err.message : 'invalid JSON' });
    }
    if (typeof body.rootPath === 'string') {
      const trimmed = body.rootPath.trim();
      if (trimmed) {
        try {
          const st = await stat(trimmed);
          if (!st.isDirectory()) return sendJson(res, 400, { error: 'Path is not a folder' });
        } catch {
          return sendJson(res, 400, { error: 'Folder not found: ' + trimmed });
        }
      }
      config.rootPath = trimmed;
    }
    if (body.minImages !== undefined) {
      const n = Number(body.minImages);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        return sendJson(res, 400, { error: 'minImages must be an integer 1-50' });
      }
      config.minImages = n;
    }
    await persistConfig();
    await rescan();
    return sendJson(res, 200, libraryPayload());
  }

  if (p === '/api/rescan' && req.method === 'POST') {
    await rescan();
    return sendJson(res, 200, libraryPayload());
  }

  // Folder browser backing the UI's path picker: browsers can't reveal
  // absolute paths from a native picker, so navigation happens server-side.
  if (p === '/api/fs' && req.method === 'GET') {
    const target = (url.searchParams.get('path') || '').trim();
    if (!target) {
      if (process.platform === 'win32') {
        const drives = [];
        await Promise.all([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(async (L) => {
          try {
            if ((await stat(`${L}:\\`)).isDirectory()) drives.push(`${L}:\\`);
          } catch {
            // drive letter not present
          }
        }));
        drives.sort();
        return sendJson(res, 200, { path: '', parent: null, sep: '\\', dirs: drives, home: os.homedir() });
      }
      return sendJson(res, 200, { path: '', parent: null, sep: '/', dirs: ['/'], home: os.homedir() });
    }
    try {
      const abs = path.resolve(target);
      const entries = await readdir(abs, { withFileTypes: true });
      const dirs = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) {
          dirs.push(e.name);
        } else if (e.isSymbolicLink()) {
          try {
            if ((await stat(path.join(abs, e.name))).isDirectory()) dirs.push(e.name);
          } catch {
            // broken link
          }
        }
      }
      dirs.sort(naturalCompare);
      const parent = path.dirname(abs);
      return sendJson(res, 200, {
        path: abs,
        parent: parent === abs ? null : parent,
        sep: path.sep,
        dirs,
        home: os.homedir(),
      });
    } catch (err) {
      return sendJson(res, 400, { error: `Cannot open folder: ${err.code ?? err.message}` });
    }
  }

  if (p.startsWith('/media/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const abs = config.rootPath ? resolveMedia(p.slice('/media/'.length)) : null;
    if (!abs) return sendJson(res, 404, { error: 'not found' });
    return streamFile(req, res, abs, { immutable: url.searchParams.has('v') });
  }

  if (p.startsWith('/thumb/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const id = p.slice('/thumb/'.length);
    const abs = config.rootPath ? resolveMedia(id) : null;
    if (!abs) return sendJson(res, 404, { error: 'not found' });
    let st;
    try {
      st = await stat(abs);
    } catch {
      return sendJson(res, 404, { error: 'not found' });
    }
    const w = snapWidth(url.searchParams.get('w'));
    let rel;
    try {
      rel = fromId(id);
    } catch {
      return sendJson(res, 404, { error: 'not found' });
    }
    const file = await thumbs.get(abs, rel, Math.floor(st.mtimeMs), w);
    return streamFile(req, res, file ?? abs, { immutable: url.searchParams.has('v') });
  }

  // static frontend
  if (req.method === 'GET' || req.method === 'HEAD') {
    let rel = p === '/' ? 'index.html' : p.slice(1);
    if (rel.includes('..') || rel.includes('\0')) return sendJson(res, 404, { error: 'not found' });
    const abs = path.join(PUBLIC_DIR, rel);
    if (!abs.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'not found' });
    return streamFile(req, res, abs);
  }

  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) sendJson(res, 500, { error: err.message ?? 'server error' });
    else res.destroy();
  });
});

server.listen(config.port, config.host, () => {
  console.log(`Simply Art Viewer  →  http://${config.host}:${server.address().port}`);
  console.log(config.rootPath
    ? `Library root: ${config.rootPath}`
    : 'No library root configured yet — open the app and set one in Setup.');
  if (config.rootPath) rescan();
});

// The desktop shell imports this module and waits on the listening server.
export { server };
