// Hash router + shared session/data caches.
// Routes:  #/           home (collections)
//          #/c/ID       collection grid
//          #/v/ID/IDX   viewer (click-zone mode)
//          #/r/ID[/IDX] rail (single-canvas scroll mode)

import * as api from './api.js';
import { homeView } from './home.js';
import { collectionView } from './collection.js';
import { viewerView } from './viewer.js';
import { railView } from './rail.js';

export const cache = { state: null, cols: new Map() };

export const session = {
  viewerFrom: 'grid',     // where the viewer was entered from: 'grid' | 'rail'
  returnIndex: null,      // item index to reveal when returning to a grid
  railAutoplay: false,    // start playback pattern as soon as rail mounts
  railPos: new Map(),     // collection id -> saved rail scroll position
  gridScroll: new Map(),  // collection id -> saved grid scroll position
};

export async function loadState(force = false) {
  if (!cache.state || force) cache.state = await api.getState();
  return cache.state;
}

export async function loadCollection(id, force = false) {
  if (!cache.cols.has(id) || force) cache.cols.set(id, await api.getCollection(id));
  return cache.cols.get(id);
}

export function invalidate() {
  cache.state = null;
  cache.cols.clear();
}

export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// Re-mount the current route (e.g. after the library was rescanned).
export function rerender() {
  route();
}

const app = document.getElementById('app');
let cleanup = null;

function route() {
  cleanup?.();
  cleanup = null;
  app.replaceChildren();
  document.body.style.overflow = '';

  const seg = location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);

  if (seg[0] === 'c' && seg[1]) {
    cleanup = collectionView(app, seg[1]);
  } else if (seg[0] === 'v' && seg[1]) {
    cleanup = viewerView(app, seg[1], parseInt(seg[2], 10) || 0);
  } else if (seg[0] === 'r' && seg[1]) {
    const idx = seg[2] === undefined ? null : parseInt(seg[2], 10) || 0;
    cleanup = railView(app, seg[1], idx);
  } else {
    cleanup = homeView(app);
  }
}

// Desktop shell (Electron): the window is frameless, so the app's own bars
// become the drag region and pad clear of the OS window controls (see the
// .desktop rules in style.css).
if (navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('desktop');
}

window.addEventListener('hashchange', route);
route();
