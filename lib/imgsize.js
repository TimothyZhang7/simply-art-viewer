// Pure-JS image dimension probe — reads only file headers, no native deps.
// Supports JPEG, PNG, GIF, WebP (VP8/VP8L/VP8X), BMP, AVIF/HEIC (ispe scan), SVG.

import { open } from 'node:fs/promises';
import path from 'node:path';

const FIRST_READ = 64 * 1024;
const SMALL_READ = 4096;
const MAX_READ = 1024 * 1024; // JPEG SOF can hide behind large EXIF blocks
const NEED_MORE = Symbol('need-more');

// Formats whose headers always sit in the first bytes — a 4KB read suffices.
// A misnamed file (e.g. a JPEG saved as .png) falls through NEED_MORE to the
// large read, so this is purely an I/O optimization, never a correctness one.
const SMALL_HEADER_EXTS = new Set(['.png', '.gif', '.bmp', '.webp', '.svg']);

export async function probeImageSize(absPath) {
  let fh;
  try {
    fh = await open(absPath, 'r');
    const firstLen = SMALL_HEADER_EXTS.has(path.extname(absPath).toLowerCase())
      ? SMALL_READ
      : FIRST_READ;
    let buf = Buffer.alloc(firstLen);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead < 12) return null;
    // final: this window holds the whole file (or is the largest we'll read),
    // so window-sensitive parsers may trust what they find in it.
    let dim = parseBuffer(buf.subarray(0, bytesRead), bytesRead < firstLen);
    if (dim === NEED_MORE) {
      const big = Buffer.alloc(MAX_READ);
      const r2 = await fh.read(big, 0, big.length, 0);
      dim = parseBuffer(big.subarray(0, r2.bytesRead), true);
      if (dim === NEED_MORE) dim = null;
    }
    return sane(dim);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function sane(dim) {
  if (!dim) return null;
  const { width, height } = dim;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 1 || height < 1 || width > 100000 || height > 100000) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

function parseBuffer(b, final) {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const dib = b.readUInt32LE(14);
    if (dib === 12) {
      // legacy OS/2 BITMAPCOREHEADER: u16 dims at 18/20
      return { width: b.readUInt16LE(18), height: b.readUInt16LE(20) };
    }
    return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    return jpegSize(b);
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return webpSize(b);
  }
  if (b.length >= 16 && b.toString('latin1', 4, 8) === 'ftyp') {
    // A truncated window can show a tile/thumbnail ispe while the canvas ispe
    // sits beyond it — only trust the scan when we hold the whole meta range.
    if (!final) return NEED_MORE;
    return ispeSize(b); // AVIF / HEIC family
  }
  return svgSize(b, final);
}

function jpegSize(b) {
  let i = 2;
  let orientation = 1;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // standalone
    if (i + 4 > b.length) return NEED_MORE;
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (marker === 0xe1) {
      const o = exifOrientation(b, i + 4, Math.min(i + 2 + len, b.length));
      if (o) orientation = o;
    }
    const isSOF = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (i + 9 > b.length) return NEED_MORE;
      let width = b.readUInt16BE(i + 7);
      let height = b.readUInt16BE(i + 5);
      // Browsers render honoring EXIF orientation; report the displayed shape.
      if (orientation >= 5) [width, height] = [height, width];
      return { width, height };
    }
    if (marker === 0xda) return null; // start of scan, SOF never appeared
    i += 2 + len;
  }
  return NEED_MORE;
}

// Reads the TIFF IFD0 Orientation tag (0x0112) from a JPEG APP1 Exif payload.
function exifOrientation(b, start, end) {
  if (end - start < 16) return 0;
  if (b.toString('latin1', start, start + 6) !== 'Exif\0\0') return 0;
  const t = start + 6; // TIFF header
  const bo = b.toString('latin1', t, t + 2);
  const le = bo === 'II';
  if (!le && bo !== 'MM') return 0;
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (t + 8 > end || u16(t + 2) !== 42) return 0;
  const ifd = t + u32(t + 4);
  if (ifd < t || ifd + 2 > end) return 0;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return 0;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

function webpSize(b) {
  const fourcc = b.toString('latin1', 12, 16);
  if (fourcc === 'VP8 ' && b.length >= 30) {
    // lossy: 3-byte frame tag, 3-byte start code 9D 01 2A, then 14-bit dims
    if (b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }
  if (fourcc === 'VP8L' && b.length >= 25) {
    if (b[20] !== 0x2f) return null;
    const width = 1 + (((b[22] & 0x3f) << 8) | b[21]);
    const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
    return { width, height };
  }
  if (fourcc === 'VP8X' && b.length >= 30) {
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width, height };
  }
  return null;
}

// Tolerant ISOBMFF scan: locate 'ispe' property boxes and read their dims.
// Tiled/thumbnailed AVIFs carry several ispe boxes; the largest is the canvas.
// NEED_MORE when none found — the meta box may sit past the first read window.
function ispeSize(b) {
  let idx = 0;
  let best = null;
  for (;;) {
    idx = b.indexOf('ispe', idx);
    if (idx === -1) break;
    // layout from type start: +4 version/flags, +8 width u32BE, +12 height u32BE
    if (idx + 16 <= b.length) {
      const dim = sane({ width: b.readUInt32BE(idx + 8), height: b.readUInt32BE(idx + 12) });
      if (dim && (!best || dim.width * dim.height > best.width * best.height)) best = dim;
    }
    idx += 4;
  }
  return best ?? NEED_MORE;
}

function svgSize(b, final) {
  const head = b.toString('utf8');
  const looksTextual = /^[\s﻿]*</.test(head.slice(0, 64));
  if (!/<svg[\s>]/i.test(head)) {
    // An XML prolog/comment block can push <svg> past this window.
    return looksTextual && !final ? NEED_MORE : null;
  }
  const tag = head.match(/<svg[^>]*>/i)?.[0];
  if (!tag) return final ? null : NEED_MORE; // open tag straddles the window
  const num = (name) => {
    // whitespace-anchored so neither stroke-width nor width= text inside
    // another attribute's value can match; % values defer to the viewBox
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']?\\s*([\\d.]+)\\s*([a-z%]*)`, 'i'));
    if (!m || m[2] === '%') return null;
    return parseFloat(m[1]);
  };
  const w = num('width');
  const h = num('height');
  if (w && h) return { width: w, height: h };
  const vb = tag.match(/viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (vb) return { width: parseFloat(vb[1]), height: parseFloat(vb[2]) };
  return null;
}
