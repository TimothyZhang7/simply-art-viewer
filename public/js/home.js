// Home view: the collections overview + first-run setup.

import * as api from './api.js';
import { el, icons, toast, fmtCounts, clamp } from './util.js';
import { loadState, invalidate, go, session } from './main.js';
import { openSheet } from './settings.js';
import { folderBrowser } from './folderpick.js';
import { favs } from './store.js';

const GAP = 10;

export function homeView(app) {
  let alive = true;
  let ro = null;
  let relayoutRaf = 0;
  let relayout = null; // bound to the current grid's layout by render()
  // Single live status watcher for this view; stopped on unmount so an
  // orphaned view can't keep polling through a long scan.
  let activeWatch = null;

  // Keep the document scrollbar always present: justified rows re-wrap on
  // width changes, so a scrollbar popping in/out could oscillate the layout.
  document.documentElement.style.overflowY = 'scroll';

  const onResize = () => {
    cancelAnimationFrame(relayoutRaf);
    relayoutRaf = requestAnimationFrame(() => relayout?.());
  };
  window.addEventListener('resize', onResize);
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
    // Scroll to restore after the grid rebuilds: the position saved when this
    // view was left (back-navigation), or the live one (re-render after a
    // rescan). Read it before the loading spinner collapses the page height.
    const keepScroll = session.homeScroll ?? window.scrollY;
    session.homeScroll = null;
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

    // Justified mosaic, same algorithm as the collection grid: rows honor each
    // cover's real aspect ratio (extremes clamped so one panorama or tall strip
    // can't own a row), with name/count overlaid so tiles stay pure image.
    ro?.disconnect();
    const grid = el('div', { class: 'home-grid' });
    const tiles = state.collections.map((c) => {
      const favBtn = el('button', {
        class: 'fav-btn' + (favs.all().has(c.id) ? ' on' : ''),
        title: 'Favourite — favourites stay at the top',
        html: icons.star,
        onclick: (e) => {
          e.stopPropagation(); // the tile click would open the collection
          favBtn.classList.toggle('on', favs.toggle(c.id));
          // Animate only the reorder — a transition left on during window
          // resize would rubber-band every tile on every frame.
          grid.classList.add('animate');
          reorder();
          setTimeout(() => grid.classList.remove('animate'), 380);
        },
      });
      const tile = el('div', { class: 'htile', onclick: () => go(`#/c/${c.id}`) },
        favBtn,
        el('div', { class: 'ovl' },
          el('div', { class: 'name', title: c.rel || c.name }, c.name),
          el('div', { class: 'count' }, fmtCounts(c.imageCount, c.videoCount)),
        ),
      );
      const aspect = clamp(
        c.cover?.w && c.cover?.h ? c.cover.w / c.cover.h : 3 / 2,
        0.55, 2.4);
      return { el: tile, c, aspect, width: 320 };
    });

    let ordered = tiles;
    // Favourites anchor to the top; sort is stable so scan order is preserved
    // within each group. Tiles are repositioned, never rebuilt — images keep
    // their loaded state.
    const reorder = () => {
      const favSet = favs.all();
      ordered = [...tiles].sort((a, b) => favSet.has(b.c.id) - favSet.has(a.c.id));
      layout();
    };

    function layout() {
      const W = grid.clientWidth;
      if (!W) return;
      const targetH = clamp(window.innerHeight * 0.34, 180, 400);
      let y = 0;
      let row = [];
      let aspects = 0;
      const flush = (h) => {
        let x = 0;
        for (const t of row) {
          const w = t.aspect * h;
          t.el.style.left = `${x}px`;
          t.el.style.top = `${y}px`;
          t.el.style.width = `${w}px`;
          t.el.style.height = `${h}px`;
          t.width = w;
          x += w + GAP;
        }
        y += h + GAP;
        row = [];
        aspects = 0;
      };
      for (const t of ordered) {
        row.push(t);
        aspects += t.aspect;
        if (aspects * targetH + GAP * (row.length - 1) >= W) {
          flush((W - GAP * (row.length - 1)) / aspects);
        }
      }
      if (row.length) {
        flush(Math.min(targetH, (W - GAP * (row.length - 1)) / aspects));
      }
      grid.style.height = `${Math.max(0, y - GAP)}px`;
    }

    grid.append(...tiles.map((t) => t.el));
    wrap.replaceChildren(grid);
    reorder(); // first layout — needs the grid in the DOM for clientWidth
    // Geometry is final here (computed from scan dims, not image loads), so
    // the restored position anchors exactly where the view was left.
    if (keepScroll) window.scrollTo({ top: keepScroll });

    // Covers load after layout so each request matches its tile's real width.
    for (const t of tiles) {
      if (t.c.cover) {
        const img = el('img', {
          loading: 'lazy',
          decoding: 'async',
          alt: t.c.name,
          src: api.thumbUrl(t.c.cover, Math.max(t.width, 280)),
        });
        img.addEventListener('load', () => img.classList.add('on'), { once: true });
        t.el.prepend(img);
      } else {
        t.el.prepend(el('div', { class: 'empty', html: icons.image }));
      }
    }

    relayout = layout;
    // Width changes from any source (scrollbar, zoom) re-wrap the rows.
    ro = new ResizeObserver(onResize);
    ro.observe(grid);
  }

  render();
  return () => {
    alive = false;
    session.homeScroll = window.scrollY; // route() clears the DOM after this
    activeWatch?.();
    activeWatch = null;
    ro?.disconnect();
    cancelAnimationFrame(relayoutRaf);
    window.removeEventListener('resize', onResize);
    document.documentElement.style.overflowY = '';
  };
}
