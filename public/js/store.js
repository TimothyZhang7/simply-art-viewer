// Client-side preferences, persisted to localStorage, with live subscribers.

const KEY = 'sav-settings-v1';

const DEFAULTS = {
  pattern: 'cruise',   // cruise | step | breathe
  speed: 130,          // px/s for cruise & breathe
  dwell: 4,            // seconds per image for step
  ease: 1.2,           // seconds of glide between steps
  loop: 'restart',     // stop | restart | bounce
  railDir: 'vertical', // vertical | horizontal (side-by-side, for portrait sets)
  railWidthMode: 'auto', // auto: fit the collection's typical image shape
  railWidth: 100,      // % of viewport width (manual mode)
  gap: 14,             // px between rail images
  hints: true,         // first-run zone hints in viewer
  autohide: true,      // auto-hide chrome in rail/viewer
};

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

let state = load();
const subs = new Set();

export const settings = {
  get: () => state,
  set(patch) {
    state = { ...state, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    for (const fn of subs) fn(state);
  },
  sub(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  defaults: () => ({ ...DEFAULTS }),
};

// Collection ids and rail bookmarks are stable across scans (id = encoded
// relative path), so plain localStorage maps survive rescans and restarts.

function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

const FAVS_KEY = 'sav-favs-v1';

export const favs = {
  all: () => new Set(readJson(FAVS_KEY, [])),
  toggle(id) {
    const s = favs.all();
    s.has(id) ? s.delete(id) : s.add(id);
    try { localStorage.setItem(FAVS_KEY, JSON.stringify([...s])); } catch {}
    return s.has(id);
  },
};

const BOOKMARKS_KEY = 'sav-bookmarks-v1';

export const bookmarks = {
  // One bookmarked item index per collection.
  get(colId) {
    const idx = readJson(BOOKMARKS_KEY, {})[colId];
    return Number.isInteger(idx) && idx >= 0 ? idx : null;
  },
  set(colId, idx) {
    const m = readJson(BOOKMARKS_KEY, {});
    m[colId] = idx;
    try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(m)); } catch {}
  },
};
