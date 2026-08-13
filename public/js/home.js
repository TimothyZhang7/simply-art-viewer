// Home view: the collections overview + first-run setup.

import * as api from './api.js';
import { el, icons, toast, fmtCounts } from './util.js';
import { loadState, invalidate, go } from './main.js';
import { openSheet } from './settings.js';
import { folderBrowser } from './folderpick.js';
import { favs } from './store.js';

export function homeView(app) {
  let alive = true;
  // Single live status watcher for this view; stopped on unmount so an
  // orphaned view can't keep polling through a long scan.
  let activeWatch = null;
  const watch = (fn) => {
    activeWatch?.();
    activeWatch = api.watchScan(fn);
    return () => {
      activeWatch?.();
      activeWatch = null;
    };
  };

  const wrap = el('div', { class: 'wrap' });
  const rescanBtn = el('button', {
    class: 'icon-btn',
    title: 'Rescan library',
    html: icons.refresh + '<span class="lbl">Rescan</span>',
    onclick: () => doRescan(),
  });
  const bar = el('div', { class: 'bar' },
    el('img', { class: 'app-logo', src: '/logo.svg', alt: '' }),
    el('div', { class: 'title' }, 'Simply Art Viewer'),
    el('div', { class: 'spacer' }),
    rescanBtn,
    el('button', {
      class: 'icon-btn',
      title: 'Setup',
      html: icons.gear + '<span class="lbl">Setup</span>',
      onclick: () => openSheet(),
    }),
  );
  const view = el('div', { class: 'view' }, bar, wrap);
  app.append(view);

  async function doRescan() {
    rescanBtn.classList.add('primary');
    const lbl = rescanBtn.querySelector('.lbl');
    const stopWatch = watch((s) => {
      if (s.scanning && s.progress && lbl) {
        lbl.textContent = s.progress.phase === 'walk'
          ? `${s.progress.files.toLocaleString()} files…`
          : `${s.progress.probed.toLocaleString()} / ${s.progress.total.toLocaleString()}`;
      }
    });
    try {
      const state = await api.rescan();
      invalidate();
      if (state.stats) {
        toast(`Scanned ${state.stats.collections} collections · ${state.stats.images} images in ${state.stats.ms} ms`);
      }
      if (alive) render();
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      stopWatch();
      if (lbl) lbl.textContent = 'Rescan';
      rescanBtn.classList.remove('primary');
    }
  }

  async function render() {
    const loadingText = el('span', {}, 'Loading library…');
    wrap.replaceChildren(el('div', { class: 'loading' }, el('div', { class: 'spinner' }), loadingText));
    // The collections request blocks server-side while a scan runs — feed the
    // wait with live numbers from the non-blocking status endpoint.
    const stopWatch = watch((s) => {
      if (s.scanning && s.progress) loadingText.textContent = api.fmtProgress(s.progress);
    });
    let state;
    try {
      state = await loadState(true);
    } catch (err) {
      if (alive) wrap.replaceChildren(el('div', { class: 'empty-state' },
        el('h2', {}, 'Server unreachable'),
        el('p', {}, err.message)));
      return;
    } finally {
      stopWatch();
    }
    if (!alive) return;

    if (!state.config.rootPath) {
      const input = el('input', { type: 'text', placeholder: 'C:\\Users\\you\\Pictures', spellcheck: 'false' });
      const save = async () => {
        const rootPath = input.value.trim();
        if (!rootPath) return;
        btn.textContent = 'Scanning…';
        const stopWatch = watch((s) => {
          if (s.scanning && s.progress) {
            btn.textContent = s.progress.phase === 'walk'
              ? `${s.progress.files.toLocaleString()}…`
              : `${s.progress.probed.toLocaleString()} / ${s.progress.total.toLocaleString()}`;
          }
        });
        try {
          await api.saveConfig({ rootPath });
          invalidate();
          render();
        } catch (err) {
          btn.textContent = 'Scan';
          toast(err.message, { error: true });
        } finally {
          stopWatch();
        }
      };
      const btn = el('button', { class: 'btn', onclick: save }, 'Scan');
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      wrap.replaceChildren(el('div', { class: 'empty-state' },
        el('h2', {}, 'Point me at your art'),
        el('p', {}, 'Browse to a folder (or paste a path). Every folder holding a few images becomes a collection — videos alongside them come along for the ride.'),
        el('div', { class: 'row' }, input, btn),
        folderBrowser({
          initial: '',
          onPick: (p) => { input.value = p; btn.focus(); },
        }),
      ));
      return;
    }

    if (state.error) {
      wrap.replaceChildren(el('div', { class: 'empty-state' },
        el('h2', {}, 'Scan failed'),
        el('p', {}, `${state.error} — check the library path in Setup.`),
        el('button', { class: 'btn', onclick: () => openSheet() }, 'Open Setup'),
      ));
      return;
    }

    if (state.collections.length === 0) {
      wrap.replaceChildren(el('div', { class: 'empty-state' },
        el('h2', {}, 'No collections found'),
        el('p', {}, `Nothing under ${state.config.rootPath} holds ${state.config.minImages}+ images yet. Adjust the path or the threshold in Setup.`),
        el('button', { class: 'btn', onclick: () => openSheet() }, 'Open Setup'),
      ));
      return;
    }

    const grid = el('div', { class: 'card-grid' });
    const cardOf = new Map();
    for (const c of state.collections) {
      const cover = c.cover
        ? el('img', {
            class: 'cover',
            loading: 'lazy',
            decoding: 'async',
            src: api.thumbUrl(c.cover, 480),
            alt: c.name,
          })
        : el('div', { class: 'cover-empty', html: icons.image });
      const favBtn = el('button', {
        class: 'fav-btn' + (favs.all().has(c.id) ? ' on' : ''),
        title: 'Favourite — favourites stay at the top',
        html: icons.star,
        onclick: (e) => {
          e.stopPropagation(); // the card click would open the collection
          favBtn.classList.toggle('on', favs.toggle(c.id));
          reorder();
        },
      });
      cardOf.set(c.id, el('div', { class: 'col-card', onclick: () => go(`#/c/${c.id}`) },
        cover,
        favBtn,
        el('div', { class: 'meta' },
          el('div', { class: 'name', title: c.rel || c.name }, c.name),
          el('div', { class: 'count' }, fmtCounts(c.imageCount, c.videoCount)),
        ),
      ));
    }
    // Favourites anchor to the top; append() MOVES the existing card nodes, so
    // reordering never reloads or re-fades the cover images. Sort is stable —
    // scan order is preserved within each group.
    const reorder = () => {
      const favSet = favs.all();
      grid.append(...[...state.collections]
        .sort((a, b) => favSet.has(b.id) - favSet.has(a.id))
        .map((c) => cardOf.get(c.id)));
    };
    reorder();
    wrap.replaceChildren(grid);
  }

  render();
  return () => {
    alive = false;
    activeWatch?.();
    activeWatch = null;
  };
}
