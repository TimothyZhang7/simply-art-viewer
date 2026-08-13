// Thumbnail service: sharp-backed webp resizes with a disk cache.
// sharp is an optional dependency — when unavailable (or for animated/vector
// sources) the caller streams the original file instead.

import { createHash } from 'node:crypto';
import { mkdir, rename, stat, open } from 'node:fs/promises';
import path from 'node:path';

let sharp = null;
let sharpTried = false;

async function getSharp() {
  if (!sharpTried) {
    sharpTried = true;
    try {
      sharp = (await import('sharp')).default;
      sharp.cache({ memory: 128, files: 0 });
    } catch {
      sharp = null;
    }
  }
  return sharp;
}

export const THUMB_BUCKETS = [320, 640, 960, 1440, 1920, 2560];

// Encoder generation, part of the cache filename: bumping it invalidates
// thumbnails encoded by an older pipeline.
const ENC_VER = 2;

export function snapWidth(w) {
  const n = Number(w) || 640;
  for (const b of THUMB_BUCKETS) if (n <= b) return b;
  return THUMB_BUCKETS[THUMB_BUCKETS.length - 1];
}

// Animated webp keeps its animation only when served as the original file.
async function isAnimatedWebp(absPath) {
  let fh;
  try {
    fh = await open(absPath, 'r');
    const buf = Buffer.alloc(32);
    const { bytesRead } = await fh.read(buf, 0, 32, 0);
    if (bytesRead < 21) return false;
    if (buf.toString('latin1', 8, 12) !== 'WEBP') return false;
    if (buf.toString('latin1', 12, 16) !== 'VP8X') return false;
    return (buf[20] & 0x02) !== 0;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

const inflight = new Map();

export class ThumbService {
  constructor(cacheDir) {
    this.dir = path.join(cacheDir, 'thumbs');
  }

  // Returns an absolute path to a cached webp thumbnail, or null when the
  // original should be streamed as-is.
  async get(absPath, relPath, mtime, width) {
    const ext = path.extname(absPath).toLowerCase();
    if (ext === '.gif' || ext === '.svg') return null;
    const s = await getSharp();
    if (!s) return null;
    if (ext === '.webp' && (await isAnimatedWebp(absPath))) return null;

    const w = snapWidth(width);
    const key = createHash('sha1').update(relPath).digest('hex');
    const file = path.join(this.dir, `${key}-${mtime}-w${w}-e${ENC_VER}.webp`);
    try {
      await stat(file);
      return file;
    } catch {
      // not cached yet
    }

    if (inflight.has(file)) return inflight.get(file);
    const job = (async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        // Large buckets are what the full-screen viewer shows; small ones are
        // grid cells where q80 artifacts are invisible but encode volume is high.
        const webpOpts = w >= 1440
          ? { quality: 90, smartSubsample: true, effort: 4 }
          : { quality: 80, effort: 3 };
        await s(absPath)
          .rotate() // honor EXIF orientation
          .resize({ width: w, withoutEnlargement: true })
          // Without this the ICC profile is stripped while pixels keep their
          // source gamut — browsers then render P3/AdobeRGB images desaturated.
          .keepIccProfile()
          .webp(webpOpts)
          .toFile(tmp);
        await rename(tmp, file);
        return file;
      } catch {
        return null; // undecodable by sharp — stream original
      } finally {
        inflight.delete(file);
      }
    })();
    inflight.set(file, job);
    return job;
  }
}
