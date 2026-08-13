// Generate sample abstract-art collections: animated SVGs (CSS transforms
// only — they run even inside <img>), one folder per motif, six pieces each,
// deterministic variation via index-derived parameters.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const SIZES = [[1200, 1600], [1600, 1000], [1400, 1400], [1100, 1500], [1600, 900], [1250, 1550]];
const PALETTES = [
  { bg: '#0b0c0f', ink: ['#f1dec0', '#8ea8ff', '#ff8f6b'] },
  { bg: '#0e1016', ink: ['#9ee6d0', '#f1dec0', '#7f9cf5'] },
  { bg: '#120f14', ink: ['#f5b8c4', '#c9a7f5', '#f1dec0'] },
  { bg: '#0a1210', ink: ['#a8e6a1', '#e6d8a8', '#79c2b8'] },
  { bg: '#101318', ink: ['#ffd166', '#8ea8ff', '#ef7a85'] },
  { bg: '#0d0d12', ink: ['#e8eaf0', '#8ea8ff', '#f1dec0'] },
];

const svgDoc = (W, H, bg, style, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>${style}</style>
<rect width="${W}" height="${H}" fill="${bg}"/>
${body}
</svg>`;

function orbits(i, [W, H], P) {
  const cx = W / 2, cy = H / 2;
  const n = 3 + (i % 4);
  const maxR = Math.min(W, H) * 0.42;
  let style = '@keyframes spin { to { transform: rotate(360deg) } }';
  let body = '';
  for (let k = 0; k < n; k++) {
    const r = (maxR * (k + 1)) / n;
    const col = P.ink[k % P.ink.length];
    const dur = 10 + 6 * k + i * 2;
    const dir = k % 2 ? ' reverse' : '';
    style += `\n.g${k}{animation:spin ${dur}s linear infinite${dir};transform-origin:${cx}px ${cy}px}`;
    const dot = 8 + (n - k) * 4;
    body += `\n<g class="g${k}">` +
      `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${col}" stroke-opacity="0.3" stroke-width="2.5" stroke-dasharray="${4 + k * 3} ${10 + k * 4}"/>` +
      `<circle cx="${(cx + r).toFixed(1)}" cy="${cy}" r="${dot}" fill="${col}"/>` +
      `<circle cx="${cx}" cy="${(cy - r).toFixed(1)}" r="${(dot * 0.45).toFixed(1)}" fill="${col}" fill-opacity="0.55"/>` +
      `</g>`;
  }
  body += `\n<circle cx="${cx}" cy="${cy}" r="${(maxR * 0.1 + i * 3).toFixed(1)}" fill="${P.ink[i % P.ink.length]}"/>`;
  return svgDoc(W, H, P.bg, style, body);
}

function tides(i, [W, H], P) {
  const layers = 4 + (i % 3);
  let style = '';
  let body = '';
  for (let k = 0; k < layers; k++) {
    const wl = Math.round(W / (2 + k + (i % 2)));
    const amp = 30 + 18 * k + i * 4;
    const y0 = Math.round(H * (0.35 + (0.55 * k) / layers));
    const col = P.ink[k % P.ink.length];
    const dur = 9 + k * 4 + (i % 3) * 3;
    const reps = Math.ceil((2 * W) / (wl / 2));
    const d = `M 0 ${y0} q ${wl / 4} ${-amp} ${wl / 2} 0 ` +
      Array.from({ length: reps }, () => `t ${wl / 2} 0`).join(' ') +
      ` L ${2 * W} ${H} L 0 ${H} Z`;
    style += `@keyframes drift${k} { to { transform: translateX(${-wl}px) } }\n` +
      `.w${k}{animation:drift${k} ${dur}s linear infinite}\n`;
    body += `<g class="w${k}"><path d="${d}" fill="${col}" fill-opacity="${(0.15 + (0.14 * k) / layers).toFixed(2)}"/></g>\n`;
  }
  return svgDoc(W, H, P.bg, style, body);
}

function breath(i, [W, H], P) {
  const n = 5 + (i % 3);
  let defs = '';
  let style = '@keyframes br { from { transform: scale(0.82); opacity: 0.55 } to { transform: scale(1.14); opacity: 0.95 } }\n';
  let body = '';
  for (let k = 0; k < n; k++) {
    const col = P.ink[k % P.ink.length];
    const gx = Math.round(W * (0.2 + 0.6 * ((k * 0.618 + i * 0.13) % 1)));
    const gy = Math.round(H * (0.18 + 0.64 * ((k * 0.382 + i * 0.21) % 1)));
    const r = Math.round(Math.min(W, H) * (0.16 + 0.09 * ((k + i) % 3)));
    const dur = 5 + (k % 4) * 2;
    defs += `<radialGradient id="g${k}"><stop offset="0%" stop-color="${col}" stop-opacity="0.9"/><stop offset="100%" stop-color="${col}" stop-opacity="0"/></radialGradient>`;
    style += `.b${k}{animation:br ${dur}s ease-in-out ${(-k * 1.7).toFixed(1)}s infinite alternate;transform-origin:${gx}px ${gy}px}\n`;
    body += `<circle class="b${k}" cx="${gx}" cy="${gy}" r="${r}" fill="url(#g${k})"/>\n`;
  }
  return svgDoc(W, H, P.bg, style, `<defs>${defs}</defs>\n${body}`);
}

function bauhaus(i, [W, H], P) {
  const cx = W / 2, cy = H / 2;
  const u = Math.min(W, H);
  const [a, b, c] = P.ink;
  const style = `@keyframes spin { to { transform: rotate(360deg) } }
@keyframes sway { from { transform: translateY(${(-u * 0.03).toFixed(0)}px) } to { transform: translateY(${(u * 0.03).toFixed(0)}px) } }
.slow{animation:spin ${40 + i * 8}s linear infinite;transform-origin:${cx}px ${cy}px}
.mid{animation:spin ${22 + i * 5}s linear infinite reverse;transform-origin:${W * 0.32}px ${H * 0.3}px}
.sw{animation:sway ${6 + i}s ease-in-out infinite alternate}`;
  const body = `
<g class="slow">
  <rect x="${cx - u * 0.26}" y="${cy - u * 0.26}" width="${u * 0.52}" height="${u * 0.52}" fill="none" stroke="${a}" stroke-width="${8 + i * 2}"/>
  <rect x="${cx - u * 0.13}" y="${cy - u * 0.13}" width="${u * 0.26}" height="${u * 0.26}" fill="${b}" transform="rotate(${15 + i * 10} ${cx} ${cy})"/>
</g>
<g class="mid">
  <path d="M ${W * 0.32 - u * 0.18} ${H * 0.3} a ${u * 0.18} ${u * 0.18} 0 0 1 ${u * 0.36} 0 Z" fill="${c}"/>
</g>
<g class="sw">
  <circle cx="${W * 0.72}" cy="${H * 0.72}" r="${u * 0.1 + i * 6}" fill="${a}"/>
  <path d="M ${W * 0.18} ${H * 0.78} l ${u * 0.16} ${-u * 0.12} l ${u * 0.02} ${u * 0.2} Z" fill="${b}" fill-opacity="0.85"/>
</g>`;
  return svgDoc(W, H, P.bg, style, body);
}

function meteors(i, [W, H], P) {
  const n = 12 + (i % 3) * 4;
  let style = `@keyframes fall { to { transform: translate(${(-W * 0.35).toFixed(0)}px, ${(H * 1.4).toFixed(0)}px) } }\n`;
  let body = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.bg}"/><stop offset="1" stop-color="${P.ink[1]}" stop-opacity="0.16"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>`;
  for (let k = 0; k < n; k++) {
    const x = Math.round(W * ((k * 0.618 + i * 0.19) % 1.15));
    const len = 60 + ((k * 37 + i * 11) % 140);
    const col = P.ink[k % P.ink.length];
    const dur = 3.5 + ((k * 13 + i * 7) % 40) / 10;
    const y1 = -((k % 5) * 120);
    style += `.m${k}{animation:fall ${dur.toFixed(1)}s linear ${(-k * 0.7).toFixed(1)}s infinite}\n`;
    body += `<line class="m${k}" x1="${x}" y1="${y1}" x2="${x + Math.round(len * 0.25)}" y2="${y1 - len}" stroke="${col}" stroke-opacity="0.7" stroke-width="${2 + (k % 3)}" stroke-linecap="round"/>\n`;
  }
  return svgDoc(W, H, P.bg, style, body);
}

function interference(i, [W, H], P) {
  const cx = W / 2, cy = H / 2;
  const n = 14 + (i % 3) * 4;
  const gap = (Math.min(W, H) * 0.46) / n;
  const c1 = { x: cx - W * 0.06, y: cy - H * 0.04 };
  const c2 = { x: cx + W * 0.06, y: cy + H * 0.04 };
  const style = `@keyframes spin { to { transform: rotate(360deg) } }
@keyframes pulse { from { transform: scale(0.96) } to { transform: scale(1.05) } }
.ga{animation:spin ${70 + i * 15}s linear infinite;transform-origin:${c1.x}px ${c1.y}px}
.gb{animation:spin ${55 + i * 12}s linear infinite reverse;transform-origin:${c2.x}px ${c2.y}px}
.gp{animation:pulse ${9 + i * 2}s ease-in-out infinite alternate;transform-origin:${cx}px ${cy}px}`;
  const rings = (c, col, cls, dash) => {
    let s = `<g class="${cls}">`;
    for (let k = 1; k <= n; k++) {
      s += `<circle cx="${c.x}" cy="${c.y}" r="${(gap * k).toFixed(1)}" fill="none" stroke="${col}" stroke-opacity="${(0.85 - (0.35 * k) / n).toFixed(2)}" stroke-width="4" stroke-dasharray="${dash}"/>`;
    }
    return s + '</g>';
  };
  const body = `<g class="gp">${rings(c1, P.ink[0], 'ga', '10 7')}${rings(c2, P.ink[1], 'gb', '16 9')}</g>`;
  return svgDoc(W, H, P.bg, style, body);
}

const MOTIFS = [
  ['Orbit Studies', 'orbit', orbits],
  ['Tide Lines', 'tide', tides],
  ['Breath', 'breath', breath],
  ['Bauhaus Drift', 'bauhaus', bauhaus],
  ['Meteor Rain', 'meteor', meteors],
  ['Interference', 'moire', interference],
];

let count = 0;
for (let m = 0; m < MOTIFS.length; m++) {
  const [name, slug, fn] = MOTIFS[m];
  const dir = path.join(ROOT, name);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 6; i++) {
    const size = SIZES[(i + m) % SIZES.length];
    const pal = PALETTES[(i + m * 2) % PALETTES.length];
    await writeFile(path.join(dir, `${slug}-${String(i + 1).padStart(2, '0')}.svg`), fn(i, size, pal));
    count++;
  }
}
console.log(`wrote ${count} pieces into ${MOTIFS.length} collections under ${ROOT}`);
