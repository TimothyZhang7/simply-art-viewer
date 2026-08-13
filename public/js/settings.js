// Setup sheet: library config (server-side) + playback / rail / interface
// preferences (client-side, applied live).

import * as api from './api.js';
import { el, icons, toast } from './util.js';
import { settings } from './store.js';
import { invalidate, rerender, loadState } from './main.js';
import { folderBrowser } from './folderpick.js';

let open = false;
let nodes = null;

export const isSheetOpen = () => open;

export function openSheet() {
  if (open) return;
  open = true;

  const st = settings.get();
  const root = document.getElementById('sheet-root');

  // ---- library section ----------------------------------------------------

  const pathInput = el('input', { type: 'text', placeholder: 'Folder to scan…', spellcheck: 'false' });
  const minInput = el('input', { type: 'number', min: '1', max: '50' });
  const statsLine = el('div', { class: 'd' }, 'Loading…');
  const applyBtn = el('button', { class: 'btn', disabled: '' }, 'Apply & scan');

  const showStats = (state) => {
    if (state.error) statsLine.textContent = `Scan failed: ${state.error}`;
    else if (!state.config.rootPath) statsLine.textContent = 'No library configured';
    else if (state.stats) {
      statsLine.textContent =
        `${state.stats.collections} collections · ${state.stats.images} images · ${state.stats.videos} videos`;
    } else statsLine.textContent = '';
  };

  let loadedMin = null;
  let pathEdited = false;
  let minEdited = false;
  pathInput.addEventListener('input', () => { pathEdited = true; });
  minInput.addEventListener('input', () => { minEdited = true; });

  // Keep the library controls disabled until the real config is in — applying
  // before that would clobber the stored settings with placeholder values.
  loadState().then((state) => {
    // never clobber what the user already typed while this was loading
    if (!pathEdited) pathInput.value = state.config.rootPath || '';
    loadedMin = state.config.minImages;
    if (!minEdited) minInput.value = String(loadedMin);
    showStats(state);
    applyBtn.disabled = false;
  }).catch((err) => {
    statsLine.textContent = `Could not load current config (${err.message}) — applying will overwrite stored settings.`;
    applyBtn.disabled = false; // still allow setting a path when the cache was cold
  });

  async function applyLibrary() {
    if (applyBtn.disabled) return;
    const n = parseInt(minInput.value, 10);
    const min = Number.isNaN(n) ? (loadedMin ?? 2) : Math.min(50, Math.max(1, n));
    minInput.value = String(min);
    applyBtn.textContent = 'Scanning…';
    applyBtn.disabled = true;
    const stopWatch = api.watchScan((s) => {
      if (s.scanning && s.progress) statsLine.textContent = api.fmtProgress(s.progress);
    });
    try {
      const state = await api.saveConfig({
        rootPath: pathInput.value.trim(),
        minImages: min,
      });
      invalidate();
      loadedMin = min;
      showStats(state);
      if (state.error) toast(state.error, { error: true });
      else if (!state.config.rootPath) toast('Library cleared');
      else toast(`Found ${state.collections.length} collections`);
      rerender();
      // route() resets the body scroll lock — re-assert it while we're open
      document.body.style.overflow = 'hidden';
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      stopWatch();
      applyBtn.textContent = 'Apply & scan';
      applyBtn.disabled = false;
    }
  }
  applyBtn.addEventListener('click', applyLibrary);
  const submitOnEnter = (e) => { if (e.key === 'Enter') applyLibrary(); };
  pathInput.addEventListener('keydown', submitOnEnter);
  minInput.addEventListener('keydown', submitOnEnter);

  // Folder browser, toggled by the Browse button next to the path field.
  const fbHost = el('div');
  const browseBtn = el('button', {
    class: 'icon-btn', title: 'Browse folders', html: icons.folder,
    onclick: () => {
      if (fbHost.firstChild) {
        fbHost.replaceChildren();
        browseBtn.classList.remove('primary');
        return;
      }
      browseBtn.classList.add('primary');
      fbHost.replaceChildren(folderBrowser({
        initial: pathInput.value,
        onPick: (p) => {
          pathInput.value = p;
          pathEdited = true;
          applyBtn.focus();
        },
      }));
    },
  });

  // ---- widget helpers -----------------------------------------------------

  const row = (label, desc, ...controls) =>
    el('div', { class: 'set-row' },
      el('div', { class: 'lab' }, label, desc ? el('div', { class: 'd' }, desc) : null),
      ...controls);

  function slider(key, min, max, stepV, unit, scale = 1) {
    const out = el('output', {}, fmt(settings.get()[key]));
    const input = el('input', {
      type: 'range', min: String(min), max: String(max), step: String(stepV),
      value: String(settings.get()[key]),
    });
    function fmt(v) { return `${Math.round(v * scale * 10) / 10}${unit}`; }
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      settings.set({ [key]: v });
      out.textContent = fmt(v);
    });
    return [input, out];
  }

  function seg(key, options) {
    const box = el('div', { class: 'seg' });
    const btns = options.map(([value, label]) => {
      const b = el('button', { class: settings.get()[key] === value ? 'on' : '' }, label);
      b.addEventListener('click', () => {
        settings.set({ [key]: value });
        box.update(value);
      });
      return b;
    });
    box.update = (value) =>
      btns.forEach((x, k) => x.classList.toggle('on', options[k][0] === value));
    box.append(...btns);
    return box;
  }

  function toggle(key, onChange) {
    const b = el('button', { class: 'switch' + (settings.get()[key] ? ' on' : '') });
    b.addEventListener('click', () => {
      const next = !settings.get()[key];
      settings.set({ [key]: next });
      b.classList.toggle('on', next);
      onChange?.(next);
    });
    return b;
  }

  // Rail width: auto by default; touching the manual slider switches modes.
  const widthMode = seg('railWidthMode', [['auto', 'Auto'], ['manual', 'Manual']]);
  const [widthInput, widthOut] = slider('railWidth', 30, 100, 1, '%');
  widthInput.addEventListener('input', () => {
    if (settings.get().railWidthMode !== 'manual') {
      settings.set({ railWidthMode: 'manual' });
      widthMode.update('manual');
    }
  });

  // ---- assemble -----------------------------------------------------------

  const body = el('div', { class: 'sheet-body' },
    el('div', { class: 'set-section' },
      el('h3', {}, 'Library'),
      row('Folder to scan', null, pathInput, browseBtn),
      fbHost,
      row('Min images per collection', 'Folders holding at least this many images become collections', minInput),
      el('div', { class: 'set-row' }, el('div', { class: 'lab' }, statsLine), applyBtn),
    ),
    el('div', { class: 'set-section' },
      el('h3', {}, 'Playback (rail auto-scroll)'),
      row('Pattern', 'Cruise glides steadily · Step pauses on each image · Breathe slows near each image',
        seg('pattern', [['cruise', 'Cruise'], ['step', 'Step'], ['breathe', 'Breathe']])),
      row('Speed', 'Cruise & Breathe', ...slider('speed', 20, 600, 5, ' px/s')),
      row('Dwell', 'Step: seconds resting on each image', ...slider('dwell', 0.5, 15, 0.5, ' s')),
      row('Glide', 'Step: seconds moving between images', ...slider('ease', 0.3, 3, 0.1, ' s')),
      row('At the end', null,
        seg('loop', [['stop', 'Stop'], ['restart', 'Restart'], ['bounce', 'Bounce']])),
    ),
    el('div', { class: 'set-section' },
      el('h3', {}, 'Rail'),
      row('Direction', 'Horizontal lays images side by side — made for portrait sets',
        seg('railDir', [['vertical', 'Vertical'], ['horizontal', 'Horizontal']])),
      row('Image size', "Auto fits the collection's typical image shape to your screen", widthMode),
      row('Manual size', 'Percent of screen width (height when horizontal) · dragging switches to Manual', widthInput, widthOut),
      row('Spacing', null, ...slider('gap', 0, 64, 1, ' px')),
    ),
    el('div', { class: 'set-section' },
      el('h3', {}, 'Interface'),
      row('Zone hints', 'Show the click-zone guide when entering the viewer',
        // re-arm the one-time guide whenever the toggle is switched on
        toggle('hints', (on) => { if (on) localStorage.removeItem('sav-zones-seen'); })),
      row('Auto-hide controls', null, toggle('autohide')),
    ),
  );

  const backdrop = el('div', { class: 'sheet-backdrop', onclick: close });
  const sheet = el('div', { class: 'sheet', tabindex: '-1' },
    el('div', { class: 'sheet-grip' }),
    el('div', { class: 'sheet-head' },
      el('h2', {}, 'Setup'),
      el('button', { class: 'icon-btn', html: icons.x, onclick: close })),
    body,
  );
  root.append(backdrop, sheet);

  // Modality: park focus in the sheet, make the page behind inert (blocks
  // both Tab and clicks landing under the backdrop) and freeze its scroll.
  const appEl = document.getElementById('app');
  const opener = document.activeElement;
  const prevOverflow = document.body.style.overflow;
  const openHash = location.hash;
  appEl.inert = true;
  document.body.style.overflow = 'hidden';
  sheet.focus();

  requestAnimationFrame(() => {
    backdrop.classList.add('on');
    sheet.classList.add('on');
  });

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  window.addEventListener('keydown', onKey, { capture: true });
  nodes = { backdrop, sheet, onKey };

  function close() {
    if (!open) return;
    open = false;
    window.removeEventListener('keydown', nodes.onKey, { capture: true });
    appEl.inert = false;
    // If the route changed while we were open (e.g. a rescan bounced a stale
    // view home), the captured overflow belongs to a dead view — the mounted
    // view owns the lock now, so only restore for an unchanged route.
    document.body.style.overflow = location.hash === openHash ? prevOverflow : '';
    if (opener?.isConnected) opener.focus?.();
    backdrop.classList.remove('on');
    sheet.classList.remove('on');
    setTimeout(() => {
      backdrop.remove();
      sheet.remove();
    }, 340);
    nodes = null;
  }
}
