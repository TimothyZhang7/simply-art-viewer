// Server-backed folder browser. Browsers deliberately never reveal absolute
// filesystem paths from their native pickers, so picking a scan root walks
// the tree through the local server's /api/fs instead.

import * as api from './api.js';
import { el, icons } from './util.js';

export function folderBrowser({ initial, onPick }) {
  let cur = null; // last loaded listing

  const pathLabel = el('div', { class: 'fb-path' }, '…');
  const list = el('div', { class: 'fb-list' });
  const upBtn = el('button', {
    class: 'icon-btn', title: 'Up one level', html: icons.chevronUp,
    onclick: () => { if (cur && cur.path) load(cur.parent ?? ''); },
  });
  const drivesBtn = el('button', {
    class: 'icon-btn', title: 'Drives', html: icons.hdd,
    onclick: () => load(''),
  });
  const homeBtn = el('button', {
    class: 'icon-btn', title: 'Home folder', html: icons.home,
    onclick: () => { if (cur?.home) load(cur.home); },
  });
  const pickBtn = el('button', {
    class: 'btn fb-pick', disabled: '',
    onclick: () => { if (cur?.path) onPick(cur.path); },
  }, 'Use this folder');

  const box = el('div', { class: 'fb' },
    el('div', { class: 'fb-bar' }, upBtn, drivesBtn, homeBtn, pathLabel, pickBtn),
    list,
  );

  async function load(p) {
    list.replaceChildren(el('div', { class: 'fb-empty' }, 'Loading…'));
    let d;
    try {
      d = await api.browseFs(p);
    } catch (err) {
      if (p) { load(''); return; } // unreadable start path → fall back to drives
      list.replaceChildren(el('div', { class: 'fb-empty' }, err.message));
      return;
    }
    cur = d;
    pathLabel.textContent = d.path || 'Drives';
    pathLabel.title = d.path || '';
    pickBtn.disabled = !d.path;
    upBtn.disabled = !d.path;
    if (!d.dirs.length) {
      list.replaceChildren(el('div', { class: 'fb-empty' }, 'No subfolders — use the button above to pick this folder'));
      return;
    }
    list.replaceChildren(...d.dirs.map((name) => {
      // folder names are untrusted text — always insert as text nodes
      const row = el('div', { class: 'fb-row' },
        el('span', { class: 'fb-ic', html: d.path ? icons.folder : icons.hdd }),
        el('span', { class: 'fb-name' }, name),
        el('span', { class: 'fb-go', html: icons.chevronRight }),
      );
      row.addEventListener('click', () => {
        load(d.path ? (d.path.endsWith(d.sep) ? d.path + name : d.path + d.sep + name) : name);
      });
      return row;
    }));
  }

  load((initial || '').trim());
  return box;
}
