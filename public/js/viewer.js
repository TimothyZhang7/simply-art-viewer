// Viewer: full-screen single item with click zones.
//   left / right  → previous / next
//   top           → back to the collection (or rail, wherever you came from)
//   bottom        → open setup
// Also: arrow keys, Esc, swipe left/right, swipe down = back, swipe up = setup.

import * as api from './api.js';
import { el, icons, toast, clamp } from './util.js';
import { loadCollection, session, go } from './main.js';
import { openSheet, isSheetOpen } from './settings.js';
import { settings } from './store.js';

const SLIDE_MS = 340;

export function viewerView(app, colId, startIndex) {
  let alive = true;
  let items = [];
  let i = 0;
  let transitioning = false;
  let pendingDir = 0;
  let suppressClick = false;
  let hideTimer = 0;

  const track = el('div', { class: 'v-track' });
  const counter = el('div', { class: 'v-counter' });
  const viewer = el('div', { class: 'viewer' }, track, counter);
  app.append(viewer);
  document.body.style.overflow = 'hidden';
  // Native image drag would hijack mouse swipes.
  viewer.addEventListener('dragstart', (e) => e.preventDefault());

  // ---- slides -------------------------------------------------------------

  function slideFor(idx) {
    const slide = el('div', { class: 'v-slide' });
    const it = items[idx];
    if (!it) return slide;
    if (it.type === 'video') {
      const v = el('video', {
        controls: '', playsinline: '', preload: 'metadata',
        src: api.mediaUrl(it),
      });
      slide.append(v);
    } else {
      const img = el('img', {
        decoding: 'async',
        alt: it.name,
        src: api.thumbUrl(it, Math.max(window.innerWidth, window.innerHeight)),
      });
      if (img.complete) img.classList.add('on');
      else img.addEventListener('load', () => img.classList.add('on'), { once: true });
      slide.append(img);
    }
    return slide;
  }

  // The bucketed thumb paints instantly; the slide being viewed then swaps to
  // the original once it has decoded off the main thread, so the upgrade never
  // flashes or drops a frame. Originals past this pixel count decode too slowly
  // (and can exhaust memory) — those upgrade to the largest bucket instead.
  const FULL_MAX_PIXELS = 40e6;
  let cancelUpgrade = null;

  function upgrade(slide, it) {
    cancelUpgrade?.();
    cancelUpgrade = null;
    if (!it || it.type === 'video') return;
    if (/\.(gif|svg)$/i.test(it.name)) return; // served as originals already
    const img = slide.querySelector('img');
    if (!img) return;
    const url = it.w * it.h > FULL_MAX_PIXELS ? api.maxThumbUrl(it) : api.mediaUrl(it);
    if (img.src.endsWith(url)) return; // thumb request already hit the target
    const full = new Image();
    let cancelled = false;
    full.src = url;
    cancelUpgrade = () => { cancelled = true; full.src = ''; }; // detach aborts the fetch
    full.decode().then(() => {
      if (cancelled || !alive || !img.isConnected) return;
      img.src = url; // decoded and cached — repaints without flicker
      img.classList.add('on');
    }).catch(() => {}); // any failure keeps the thumb
  }

  function rebuild() {
    if (!alive) return;
    for (const v of track.querySelectorAll('video')) v.pause();
    track.style.transition = 'none';
    track.style.transform = 'translate3d(0,0,0)';
    track.replaceChildren(slideFor(i - 1), slideFor(i), slideFor(i + 1));
    // Commit the reset now: a step() chained in the same rendering update
    // (rapid navigation) must see transform 0 as the transition's start value,
    // or the next slide snaps instead of animating.
    void track.offsetWidth;
    const cur = items[i];
    viewer.classList.toggle('video-mode', cur?.type === 'video');
    if (cur?.type === 'video') {
      const v = track.children[1].querySelector('video');
      v?.play().catch(() => {});
    }
    upgrade(track.children[1], cur);
    counter.textContent = cur ? `${i + 1} / ${items.length} — ${cur.name}` : '';
    history.replaceState(null, '', `#/v/${colId}/${i}`);
    wake();
  }

  function step(dir) {
    if (!items.length) return;
    if (transitioning) {
      // A bounce is interruptible — landing a real step beats rubber-banding.
      if (bouncing) cancelBounce(true);
      else { pendingDir = dir; return; }
    }
    const next = i + dir;
    if (next < 0 || next >= items.length) return bounce(dir);
    transitioning = true;
    track.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(.22,1,.36,1)`;
    track.style.transform = `translate3d(${dir * -100 / 3}%,0,0)`;
    finishAfter(() => {
      i = next;
      rebuild();
      transitioning = false;
      if (pendingDir) {
        const d = pendingDir;
        pendingDir = 0;
        requestAnimationFrame(() => step(d));
      }
    });
  }

  // Pending finish for the in-flight slide transition. The transitionend
  // listener must ignore bubbled opacity fades from slide images, and the
  // whole thing must be cancellable on unmount / force-completable when a
  // drag interrupts the animation.
  let finish = null;

  function finishAfter(fn) {
    const entry = {};
    const settle = (invoke) => {
      if (finish !== entry) return;
      finish = null;
      clearTimeout(entry.timer);
      track.removeEventListener('transitionend', entry.listener);
      if (invoke && alive) fn();
    };
    entry.listener = (e) => {
      if (e.target === track && e.propertyName === 'transform') settle(true);
    };
    entry.timer = setTimeout(() => settle(true), SLIDE_MS + 90); // safety net
    entry.finish = () => settle(true);
    entry.cancel = () => settle(false);
    track.addEventListener('transitionend', entry.listener);
    finish = entry;
  }

  let bouncing = false;
  let bounceT1 = 0;
  let bounceT2 = 0;

  function cancelBounce(resetTransform) {
    if (!bouncing) return;
    bouncing = false;
    transitioning = false;
    clearTimeout(bounceT1);
    clearTimeout(bounceT2);
    if (resetTransform) {
      track.style.transition = 'none';
      track.style.transform = 'translate3d(0,0,0)';
      void track.offsetWidth;
    }
  }

  function bounce(dir) {
    transitioning = true;
    bouncing = true;
    track.style.transition = 'transform 140ms ease-out';
    track.style.transform = `translate3d(${dir * -26}px,0,0)`;
    bounceT1 = setTimeout(() => {
      track.style.transition = 'transform 260ms cubic-bezier(.22,1,.36,1)';
      track.style.transform = 'translate3d(0,0,0)';
      bounceT2 = setTimeout(() => {
        bouncing = false;
        transitioning = false;
        pendingDir = 0; // inputs queued against a bounce must not replay later
      }, 270);
    }, 150);
  }

  function springBack() {
    track.style.transition = `transform 260ms cubic-bezier(.22,1,.36,1)`;
    track.style.transform = 'translate3d(0,0,0)';
  }

  // ---- navigation targets -------------------------------------------------

  function goBack() {
    if (session.viewerFrom === 'rail') {
      go(`#/r/${colId}/${i}`);
    } else {
      session.returnIndex = i;
      go(`#/c/${colId}`);
    }
  }

  function toRail(autoplay) {
    session.railAutoplay = autoplay;
    go(`#/r/${colId}/${i}`);
  }

  // ---- click zones --------------------------------------------------------

  const zone = (cls, hint, onclick) => {
    const z = el('div', { class: `v-zone ${cls}` },
      el('div', { class: 'hint', html: hint }));
    z.addEventListener('click', () => { if (!suppressClick) onclick(); });
    return z;
  };
  const backLabel = session.viewerFrom === 'rail' ? 'Go back to rail' : 'Go back to collection';
  viewer.append(
    zone('vz-top', icons.chevronUp + `<span>${backLabel}</span>`, goBack),
    zone('vz-bottom', icons.chevronDown + '<span>Configuration</span>', () => openSheet()),
    zone('vz-left', icons.chevronLeft, () => step(-1)),
    zone('vz-right', icons.chevronRight, () => step(1)),
  );

  // ---- first-run zone hints ----------------------------------------------

  if (settings.get().hints && !localStorage.getItem('sav-zones-seen')) {
    const fh = el('div', { class: 'v-firsthint' },
      el('div', { class: 'fh fh-left', html: icons.chevronLeft + '<span>Previous</span>' }),
      el('div', { class: 'fh fh-right', html: '<span>Next</span>' + icons.chevronRight }),
      el('div', { class: 'fh fh-top', html: icons.chevronUp + `<span>${backLabel}</span>` }),
      el('div', { class: 'fh fh-bottom', html: icons.chevronDown + '<span>Configuration</span>' }),
    );
    viewer.append(fh);
    requestAnimationFrame(() => fh.classList.add('on'));
    setTimeout(() => {
      fh.classList.remove('on');
      setTimeout(() => fh.remove(), 600);
      localStorage.setItem('sav-zones-seen', '1');
    }, 3000);
  }

  // ---- chrome (counter) ---------------------------------------------------

  function wake() {
    counter.classList.add('on');
    clearTimeout(hideTimer);
    if (settings.get().autohide) {
      hideTimer = setTimeout(() => counter.classList.remove('on'), 1800);
    }
  }

  // ---- pointer swipes -----------------------------------------------------

  let pd = null;
  viewer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || pd) return; // ignore extra touches mid-gesture
    if (e.target.closest('video, button')) return;
    if (transitioning) {
      pendingDir = 0;
      if (bouncing) cancelBounce(true);
      else finish?.finish(); // land the in-flight slide so the drag starts stable
    }
    pd = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), drag: false, axis: null };
  });
  viewer.addEventListener('pointermove', (e) => {
    if (!pd || e.pointerId !== pd.id) return;
    // Mouse released outside the window before capture engaged: dead gesture.
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) {
      pd = null;
      return;
    }
    const dx = e.clientX - pd.x;
    const dy = e.clientY - pd.y;
    if (!pd.drag && Math.hypot(dx, dy) > 12) {
      pd.drag = true;
      pd.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      track.style.transition = 'none';
      // Capture only once it IS a drag: capturing on pointerdown would
      // retarget click events away from the navigation zones.
      viewer.setPointerCapture(pd.id);
    }
    if (!pd.drag) return;
    if (pd.axis === 'x') {
      const atEdge = (i === 0 && dx > 0) || (i === items.length - 1 && dx < 0);
      track.style.transform = `translate3d(${atEdge ? dx * 0.3 : dx}px,0,0)`;
    } else {
      track.style.transform = `translate3d(0,${dy * 0.55}px,0)`;
      viewer.style.background = `rgba(0,0,0,${1 - clamp(Math.abs(dy) / 900, 0, 0.35)})`;
    }
  });
  const endDrag = (e) => {
    if (!pd || e.pointerId !== pd.id) return;
    const dx = e.clientX - pd.x;
    const dy = e.clientY - pd.y;
    const dt = Math.max(1, performance.now() - pd.t);
    const wasDrag = pd.drag;
    const axis = pd.axis;
    pd = null;
    viewer.style.background = '';
    if (!wasDrag) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 60);
    if (axis === 'x') {
      const vx = (dx / dt) * 1000;
      if (dx < -Math.min(90, innerWidth * 0.16) || vx < -480) step(1);
      else if (dx > Math.min(90, innerWidth * 0.16) || vx > 480) step(-1);
      else springBack();
    } else {
      if (dy > 100) { springBack(); goBack(); }
      else if (dy < -100) { springBack(); openSheet(); }
      else springBack();
    }
  };
  viewer.addEventListener('pointerup', endDrag);
  viewer.addEventListener('pointercancel', endDrag);
  viewer.addEventListener('pointermove', wake, { passive: true });

  // ---- keyboard -----------------------------------------------------------

  function onKey(e) {
    if (isSheetOpen()) return;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); step(-1); break;
      case 'ArrowRight': e.preventDefault(); step(1); break;
      case 'ArrowUp': case 'Escape': e.preventDefault(); goBack(); break;
      case 'ArrowDown': e.preventDefault(); openSheet(); break;
      case 'r': toRail(false); break;
      case ' ': e.preventDefault(); toRail(true); break;
      case 'f':
        if (document.fullscreenElement) document.exitFullscreen();
        else viewer.requestFullscreen?.().catch(() => {});
        break;
    }
  }
  window.addEventListener('keydown', onKey);

  // ---- load ---------------------------------------------------------------

  (async () => {
    let data;
    try {
      data = await loadCollection(colId);
    } catch (err) {
      if (alive) { toast(err.message, { error: true }); go('#/'); }
      return;
    }
    if (!alive) return;
    items = data.items;
    i = clamp(startIndex, 0, Math.max(0, items.length - 1));
    rebuild();
    wake();
  })();

  return () => {
    alive = false;
    finish?.cancel(); // orphaned timers must not rewrite the URL or start media
    cancelBounce(false);
    cancelUpgrade?.();
    clearTimeout(hideTimer);
    for (const v of track.querySelectorAll('video')) v.pause();
    window.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
  };
}
