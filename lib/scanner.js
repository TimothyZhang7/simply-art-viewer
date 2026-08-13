// Library scanner: walks the configured root and heuristically groups folders
// into collections. A folder whose direct image count >= minImages becomes a
// collection; media in non-collection descendant folders (e.g. a `clips/`
// subfolder holding a video) attaches to its nearest collection ancestor.

import { readdir, stat, mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { probeImageSize } from './imgsize.js';

export const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.jfif', '.png', '.gif', '.webp', '.avif', '.bmp', '.svg',
]);
export const VIDEO_EXTS = new Set([
  '.mp4', '.webm', '.mov', '.m4v', '.mkv', '.ogv',
]);

const SKIP_DIRS = new Set(['node_modules', '.savcache', '$recycle.bin', 'system volume information']);

export const toId = (relPosix) => Buffer.from(relPosix, 'utf8').toString('base64url');
export const fromId = (id) => Buffer.from(id, 'base64url').toString('utf8');

// Numeric-aware ordering so "img2" sorts before "img10".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

// One manifest file per scanned root, so switching libraries (or running two
// instances against different roots) never wipes another root's cache.
const manifestName = (root) =>
  `manifest-${createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12)}.json`;

async function loadManifest(cacheDir, root) {
  try {
    const m = JSON.parse(await readFile(path.join(cacheDir, manifestName(root)), 'utf8'));
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

async function saveManifest(cacheDir, root, manifest) {
  try {
    await mkdir(cacheDir, { recursive: true });
    const tmp = path.join(cacheDir, `manifest.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(manifest));
    await rename(tmp, path.join(cacheDir, manifestName(root)));
  } catch {
    // cache is best-effort
  }
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const WALK_CONCURRENCY = 16;
const PROBE_CONCURRENCY = 64;

export async function scanLibrary(rootPath, { minImages = 2, cacheDir, onProgress } = {}) {
  const started = Date.now();
  const root = path.resolve(rootPath);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error('Root path is not a directory');

  let lastEmit = 0;
  const emit = (p, force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (force || now - lastEmit > 80) {
      lastEmit = now;
      try {
        onProgress(p);
      } catch {
        // a progress listener must never be able to break the scan
      }
    }
  };

  // Walk the tree with concurrent directory reads — walks are latency-bound
  // (especially on HDD/NAS), so parallel readdirs dominate serial walking.
  // dirs: relPosix -> { images: [relPosix], videos: [relPosix] }
  //
  // Cycle guard: each directory's canonical path is derived from its parent's
  // (one realpath syscall ONLY when crossing a symlink/junction), and every
  // canonical path is recorded, so any link back into the walked tree is
  // rejected on first sight.
  const dirs = new Map();
  const rootReal = await realpath(root).catch(() => root);
  const seenReal = new Set([rootReal]);
  let filesSeen = 0;

  await new Promise((resolveWalk) => {
    const pending = [{ rel: '', real: rootReal }];
    // Link-crossing dirs wait here until every direct path has been walked, so
    // when a folder is reachable both directly and through a junction, the
    // DIRECT rel deterministically wins — ids and manifest keys stay stable
    // across rescans regardless of worker scheduling.
    const linkQueue = [];
    let running = 0;

    const scanDir = async ({ rel, real }) => {
      const abs = rel ? path.join(root, ...rel.split('/')) : root;
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      const rec = { images: [], videos: [] };
      dirs.set(rel, rec);
      for (const e of entries) {
        const name = e.name;
        if (name.startsWith('.')) continue;
        const childRel = rel ? `${rel}/${name}` : name;
        let isDir = e.isDirectory();
        let isFile = e.isFile();
        const viaLink = e.isSymbolicLink();
        if (viaLink) {
          try {
            const st = await stat(path.join(abs, name)); // follows the link
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch {
            continue; // broken link
          }
        }
        if (isDir) {
          if (SKIP_DIRS.has(name.toLowerCase())) continue;
          if (viaLink) {
            const childReal = await realpath(path.join(abs, name)).catch(() => null);
            if (!childReal) continue; // unresolvable link could be a cycle
            linkQueue.push({ rel: childRel, real: childReal });
            continue;
          }
          const childReal = path.join(real, name);
          if (seenReal.has(childReal)) continue;
          seenReal.add(childReal);
          pending.push({ rel: childRel, real: childReal });
        } else if (isFile) {
          const ext = path.extname(name).toLowerCase();
          if (IMAGE_EXTS.has(ext)) rec.images.push(childRel);
          else if (VIDEO_EXTS.has(ext)) rec.videos.push(childRel);
          else continue;
          filesSeen++;
          emit({ phase: 'walk', dirs: dirs.size, files: filesSeen });
        }
      }
    };

    const pump = () => {
      while (pending.length && running < WALK_CONCURRENCY) {
        const entry = pending.pop();
        running++;
        scanDir(entry)
          .catch(() => {})
          .finally(() => {
            running--;
            pump();
          });
      }
      if (!pending.length && running === 0) {
        if (linkQueue.length) {
          // phase 2: dive linked dirs, in a stable order, skipping any target
          // some direct path (or earlier link) already claimed
          linkQueue.sort((a, b) => naturalCompare(a.rel, b.rel));
          for (const entry of linkQueue) {
            if (seenReal.has(entry.real)) continue;
            seenReal.add(entry.real);
            pending.push(entry);
          }
          linkQueue.length = 0;
          if (pending.length) {
            pump();
            return;
          }
        }
        resolveWalk();
      }
    };
    pump();
  });
  emit({ phase: 'walk', dirs: dirs.size, files: filesSeen }, true);

  // Collections: folders with enough direct images.
  const collectionRels = new Set();
  for (const [rel, rec] of dirs) {
    if (rec.images.length >= Math.max(1, minImages)) collectionRels.add(rel);
  }

  const nearestCollectionAncestor = (rel) => {
    let cur = rel;
    while (cur !== '') {
      const cut = cur.lastIndexOf('/');
      cur = cut === -1 ? '' : cur.slice(0, cut);
      if (collectionRels.has(cur)) return cur;
    }
    return null;
  };

  // Gather members: own media plus media attached from non-collection descendants.
  const members = new Map(); // collectionRel -> { images: [], videos: [] }
  for (const rel of collectionRels) {
    const rec = dirs.get(rel);
    members.set(rel, { images: [...rec.images], videos: [...rec.videos] });
  }
  for (const [rel, rec] of dirs) {
    if (collectionRels.has(rel)) continue;
    if (rec.images.length === 0 && rec.videos.length === 0) continue;
    const home = nearestCollectionAncestor(rel);
    if (!home) continue;
    const m = members.get(home);
    m.images.push(...rec.images);
    m.videos.push(...rec.videos);
  }

  // Stat + probe every member file in ONE flat pool spanning all collections
  // (a per-collection pool starves on small collections), reusing the manifest
  // cache keyed by relPath so unchanged files are never re-read.
  const manifest = cacheDir ? await loadManifest(cacheDir, root) : {};
  const nextManifest = {};

  const sortedRels = [...collectionRels].sort(naturalCompare);
  const jobs = [];
  for (const rel of sortedRels) {
    const m = members.get(rel);
    m.images.sort(naturalCompare);
    m.videos.sort(naturalCompare);
    for (const f of m.images) jobs.push({ rel: f, type: 'image' });
    for (const f of m.videos) jobs.push({ rel: f, type: 'video' });
  }

  let probed = 0;
  const jobDone = () => {
    probed++;
    emit({ phase: 'probe', probed, total: jobs.length });
  };
  const built = await mapPool(jobs, PROBE_CONCURRENCY, async ({ rel, type }) => {
    const abs = path.join(root, ...rel.split('/'));
    let st;
    try {
      st = await stat(abs);
    } catch {
      jobDone();
      return null;
    }
    const mtime = Math.floor(st.mtimeMs);
    let w = null;
    let h = null;
    if (type === 'image') {
      const cached = manifest[rel];
      if (cached && cached.m === mtime && cached.s === st.size) {
        w = cached.w;
        h = cached.h;
      } else {
        const dim = await probeImageSize(abs);
        if (dim) { w = dim.width; h = dim.height; }
      }
      // Only cache successful probes: a null result may be a transient read
      // failure (file locked by another app), and negative-caching it would
      // stick forever since the mtime/size key never changes.
      if (w !== null && h !== null) nextManifest[rel] = { w, h, m: mtime, s: st.size };
    }
    jobDone(); // count only fully processed jobs, or the bar hits 100% early
    return {
      id: toId(rel),
      rel,
      name: path.basename(rel),
      type,
      w,
      h,
      size: st.size,
      v: mtime,
    };
  });
  emit({ phase: 'probe', probed, total: jobs.length }, true);

  const itemByRel = new Map();
  jobs.forEach((job, k) => {
    if (built[k]) itemByRel.set(job.rel, built[k]);
  });

  const collections = [];
  for (const rel of sortedRels) {
    const m = members.get(rel);
    const images = m.images.map((r) => itemByRel.get(r)).filter(Boolean);
    const videos = m.videos.map((r) => itemByRel.get(r)).filter(Boolean);
    const items = [...images, ...videos].sort((a, b) => naturalCompare(a.rel, b.rel));
    if (items.length === 0) continue;
    collections.push({
      id: toId(rel),
      rel,
      name: rel === '' ? path.basename(root) : path.basename(rel),
      parent: rel === '' ? '' : path.dirname(rel).replace(/^\.$/, ''),
      items,
      imageCount: images.length,
      videoCount: videos.length,
      cover: images[0] ?? null,
    });
  }

  // Disambiguate duplicate folder names with their parent folder.
  const nameCounts = new Map();
  for (const c of collections) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
  for (const c of collections) {
    if (nameCounts.get(c.name) > 1 && c.parent) {
      c.name = `${path.basename(c.parent)} / ${c.name}`;
    }
  }

  if (cacheDir) await saveManifest(cacheDir, root, nextManifest);

  const stats = {
    collections: collections.length,
    images: collections.reduce((n, c) => n + c.imageCount, 0),
    videos: collections.reduce((n, c) => n + c.videoCount, 0),
    ms: Date.now() - started,
  };
  return { collections, stats };
}
