// Collection view: justified grid of thumbnails.
// Geometry is precomputed from scan-time dimensions, so rows lay out with zero
// image-load reflow; tiles lazy-load via IntersectionObserver.

import * as api from './api.js';
import { el, icons, toast, fmtCounts, clamp } from './util.js';
import { loadCollection, session, go } from './main.js';
import { openSheet, isSheetOpen } from './settings.js';

const GAP = 8;

export function collectionView(app, id) {
  let alive = true;
  let data = null;
  let tiles = [];
  let io = null;
  let ro = null;
  let relayoutRaf = 0;
  // Consume immediately so a failed load can't leak the index into an
  // unrelated collection's mount later.
  const revealIndex = session.returnIndex;
  session.returnIndex = null;

  // Keep the document scrollbar always present: grid width must not depend on
  // content height, or scrollbar appearance would re-wrap rows (and could even
  // oscillate via the ResizeObserver).
  document.documentElement.style.overflowY = 'scroll';

  const jg = el('div', { class: 'jgrid' });
  const wrap = el('div', { class: 'wrap' }, jg);
  const title = el('div', { class: 'title' }, '…');
  const sub = el('div', { class: 'sub' }, '');
  const bar = el('div', { class: 'bar' },
    el('button', { class: 'icon-btn', title: 'Back (Esc)', html: icons.back, onclick: () => go('#/') }),
    title, sub,
    el('div', { class: 'spacer' }),
    el('button', {
      class: 'icon-btn', title: 'Rail mode (single canvas)',
      html: icons.rail + '<span class="lbl">Rail</span>',
      onclick: () => go(`#/r/${id}`),
    }),
    el('button', {
      class: 'icon-btn primary', title: 'Play (auto-scroll the rail)',
      html: icons.play + '<span class="lbl">Play</span>',
      onclick: () => { session.railAutoplay = true; go(`#/r/${id}`); },
    }),
    el('button', { class: 'icon-btn', title: 'Setup', html: icons.gear, onclick: () => openSheet() }),
  );
  app.append(el('div', { class: 'view' }, bar, wrap));

  const aspectOf = (it) =>
    it.w && it.h ? it.w / it.h : (it.type === 'video' ? 16 / 9 : 3 / 2);

  function layout() {
    const W = jg.clientWidth;
    if (!W || !data) return;
    const targetH = clamp(window.innerHeight * 0.3, 150, 340);
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

    for (const t of tiles) {
      row.push(t);
      aspects += t.aspect;
      if (aspects * targetH + GAP * (row.length - 1) >= W) {
        flush((W - GAP * (row.length - 1)) / aspects);
      }
    }
    if (row.length) {
      flush(Math.min(targetH, (W - GAP * (row.length - 1)) / aspects));
    }
    jg.style.height = `${Math.max(0, y - GAP)}px`;
  }

  function buildTiles() {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const t = tiles[Number(e.target.dataset.i)];
        io.unobserve(e.target);
        hydrate(t);
      }
    }, { rootMargin: '900px 0px' });

    tiles = data.items.map((it, i) => {
      const tile = el('div', { class: 'jitem', 'data-i': String(i) });
      tile.addEventListener('click', () => {
        session.viewerFrom = 'grid';
        go(`#/v/${id}/${i}`);
      });
      return { el: tile, item: it, aspect: aspectOf(it), width: 300, hydrated: false };
    });
    jg.replaceChildren(...tiles.map((t) => t.el));
    layout();
    for (const t of tiles) io.observe(t.el);
  }

  function hydrate(t) {
    if (t.hydrated) return;
    t.hydrated = true;
    if (t.item.type === 'video') {
      const v = el('video', {
        preload: 'metadata', muted: '', playsinline: '',
        src: api.mediaUrl(t.item),
      });
      v.muted = true;
      v.addEventListener('loadedmetadata', () => {
        // nudge off frame 0 so the browser paints a poster frame
        try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch {}
        v.classList.add('on');
      }, { once: true });
      t.el.append(v, el('div', { class: 'vid-badge', html: icons.play }));
    } else {
      const img = el('img', {
        decoding: 'async',
        alt: t.item.name,
        src: api.thumbUrl(t.item, Math.max(t.width, 240)),
      });
      img.addEventListener('load', () => img.classList.add('on'), { once: true });
      t.el.append(img);
    }
  }

  function onResize() {
    cancelAnimationFrame(relayoutRaf);
    relayoutRaf = requestAnimationFrame(layout);
  }

  function onKey(e) {
    if (isSheetOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); go('#/'); }
  }

  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKey);
  // Re-layout when the grid's width changes for any reason — including the
  // document scrollbar appearing after the first layout makes the page tall.
  ro = new ResizeObserver(onResize);
  ro.observe(jg);

  (async () => {
    try {
      data = await loadCollection(id);
    } catch (err) {
      if (alive) { toast(err.message, { error: true }); go('#/'); }
      return;
    }
    if (!alive) return;
    title.textContent = data.name;
    const images = data.items.filter((x) => x.type === 'image').length;
    sub.textContent = fmtCounts(images, data.items.length - images);
    buildTiles();

    if (revealIndex !== null && tiles[revealIndex]) {
      const t = tiles[revealIndex];
      const rect = parseFloat(t.el.style.top) || 0;
      window.scrollTo({ top: Math.max(0, rect - window.innerHeight * 0.35) });
    } else if (session.gridScroll.has(id)) {
      window.scrollTo({ top: session.gridScroll.get(id) });
    }
  })();

  return () => {
    alive = false;
    document.documentElement.style.overflowY = '';
    if (data) session.gridScroll.set(id, window.scrollY); // never save for a grid that failed to render
    io?.disconnect();
    ro?.disconnect();
    cancelAnimationFrame(relayoutRaf);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey);
  };
}
