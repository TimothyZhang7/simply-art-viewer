// Rail mode: the whole collection on one continuous canvas — vertical by
// default, or horizontal (images side by side, made for portrait sets).
//
// A custom scroll engine drives everything through a single GPU transform:
//   wheel    → exponential-damped glide toward a target
//   drag     → 1:1 follow with momentum + friction on release
//   keyboard → glide steps / image snapping
//   play     → configurable auto-scroll patterns (cruise / step / breathe)
// Only the visible slice of items is mounted (virtualized), so frame cost is
// constant regardless of collection size.
//
// The engine is axis-agnostic: P/T/V and every layout box ({ pos, ext }) live
// on the MAIN (scroll) axis — y when vertical, x when horizontal — and `cross`
// is the item size on the other axis. Only positionEl / render / the input
// handlers touch real x/y coordinates.

import * as api from './api.js';
import { el, icons, toast, clamp, easeInOutCubic } from './util.js';
import { loadCollection, session, go } from './main.js';
import { openSheet, isSheetOpen } from './settings.js';
import { settings, bookmarks } from './store.js';

const PAD = 16;          // canvas padding at both main-axis ends
const BUFFER_VP = 1.0;   // extra viewports mounted before/after the visible slice
const GLIDE_RATE = 11;   // exponential approach rate for wheel/key glides
const FRICTION = 2.6;    // momentum decay rate
const MIN_VEL = 12;      // px/s — momentum below this stops

export function railView(app, colId, startIndex) {
  let alive = true;
  let items = [];
  let layout = [];       // per item: { pos, ext } on the main axis
  let total = 0;
  let maxScroll = 0;
  let vw = 0, vh = 0;
  let mspan = 0;         // viewport span along the main (scroll) axis
  let cspan = 0;         // viewport span across it
  let cross = 0;         // item size on the cross axis

  let P = 0;             // current position
  let T = 0;             // glide target
  let V = 0;             // momentum velocity
  let mode = 'idle';     // idle | drag | inertia
  let sbTrack = 0;       // scrollbar track length (cached; no reads in the hot loop)
  let playing = false;
  let playDir = 1;
  let returning = false; // gliding back to the start for loop=restart
  let stepState = null;  // { phase: 'dwell'|'move', t, from, to, idx }
  let raf = 0;
  let lastT = 0;
  let dirty = true;
  let lastRange = [0, -1];
  const mounted = new Map();

  let st = settings.get();
  let horiz = st.railDir === 'horizontal';
  const mainOf = (e) => (horiz ? e.clientX : e.clientY);
  const crossOf = (e) => (horiz ? e.clientY : e.clientX);
  // Saved scroll positions are meaningless across an axis swap — scope the key.
  const posKey = () => (horiz ? colId + '|h' : colId);

  const unsub = settings.sub((next) => {
    const flip = (next.railDir === 'horizontal') !== horiz;
    const relayout = flip ||
      next.railWidth !== st.railWidth ||
      next.gap !== st.gap ||
      next.railWidthMode !== st.railWidthMode;
    st = next;
    if (flip) {
      horiz = next.railDir === 'horizontal';
      rail.classList.toggle('horiz', horiz);
      refreshDirBtn();
      // Mounted elements carry inline styles for the old axis — rebuild them.
      for (const [, elm] of mounted) { elm.querySelector('video')?.pause(); elm.remove(); }
      mounted.clear();
      sbThumb.removeAttribute('style');
    }
    if (relayout) relayoutPreservingAnchor();
    kick();
  });

  // ---- DOM ----------------------------------------------------------------

  const canvas = el('div', { class: 'rail-canvas' });
  const sbThumb = el('div', { class: 'sb-thumb' });
  const scrollbar = el('div', { class: 'rail-scrollbar' }, sbThumb);
  const playFab = el('button', { class: 'rail-play-fab', title: 'Play / pause (Space)', html: icons.play });
  const barTitle = el('div', { class: 'title' }, '…');
  const bmSetBtn = el('button', {
    class: 'icon-btn', title: 'Bookmark this image (b)', html: icons.bookmark,
    onclick: () => setBookmark(),
  });
  const bmGoBtn = el('button', {
    class: 'icon-btn', title: 'Go to bookmark', html: icons.bookmarkGo,
    onclick: () => jumpBookmark(),
  });
  const dirBtn = el('button', {
    class: 'icon-btn',
    onclick: () => settings.set({ railDir: horiz ? 'vertical' : 'horizontal' }),
  });
  const bar = el('div', { class: 'rail-bar' },
    el('button', { class: 'icon-btn', title: 'Back to grid (Esc)', html: icons.back, onclick: () => toGrid() }),
    barTitle,
    el('div', { class: 'spacer' }),
    bmSetBtn,
    bmGoBtn,
    dirBtn,
    el('button', { class: 'icon-btn', title: 'Grid view', html: icons.grid, onclick: () => toGrid() }),
    el('button', { class: 'icon-btn', title: 'Setup', html: icons.gear, onclick: () => openSheet() }),
  );
  const rail = el('div', { class: 'rail' + (horiz ? ' horiz' : '') }, canvas, bar, scrollbar, playFab);
  app.append(rail);
  document.body.style.overflow = 'hidden';
  // Native HTML5 image drag would hijack drag-to-scroll on mouse.
  rail.addEventListener('dragstart', (e) => e.preventDefault());

  // The icon shows the mode a click switches TO, like the play/pause fab.
  function refreshDirBtn() {
    dirBtn.innerHTML = horiz ? icons.rail : icons.railH;
    dirBtn.title = horiz ? 'Vertical rail' : 'Horizontal rail';
  }
  refreshDirBtn();

  function toGrid() {
    go(`#/c/${colId}`);
  }

  // ---- bookmark (one per collection, persisted) ---------------------------

  function refreshBookmarkUi() {
    bmGoBtn.hidden = bookmarks.get(colId) === null;
  }
  refreshBookmarkUi();

  function setBookmark() {
    if (!items.length) return;
    const idx = centerIndex();
    bookmarks.set(colId, idx);
    refreshBookmarkUi();
    toast(`Bookmarked image ${idx + 1}`);
  }

  function jumpBookmark() {
    const idx = bookmarks.get(colId);
    if (idx === null || !items.length) return;
    stopPlaying();
    mode = 'idle';
    V = 0;
    T = stopPos(clamp(idx, 0, items.length - 1));
    kick();
  }

  // ---- layout -------------------------------------------------------------

  // Main-axis extent per unit of cross size (ext = cross * mainAspect).
  const mainAspect = (it) => {
    const hw = it.w && it.h ? it.h / it.w : (it.type === 'video' ? 9 / 16 : 2 / 3);
    return horiz ? 1 / hw : hw;
  };

  // Auto sizing: fit the collection's TYPICAL image (median aspect, robust
  // against a few outliers) to the viewport's main span — portrait sets get a
  // narrower column in vertical mode and full height in horizontal, landscape
  // sets do the reverse.
  function autoCrossPct() {
    const aspects = items
      .filter((it) => it.w && it.h)
      .map(mainAspect)
      .sort((a, b) => a - b);
    if (!aspects.length || !mspan || !cspan) return 100;
    const median = aspects[aspects.length >> 1];
    const fit = (mspan * 0.94) / median;
    return clamp((fit / cspan) * 100, 30, 100);
  }

  function computeLayout() {
    vw = rail.clientWidth;
    vh = rail.clientHeight;
    mspan = horiz ? vw : vh;
    cspan = horiz ? vh : vw;
    sbTrack = Math.max(0, mspan - 8); // .rail-scrollbar is inset 4px at each end
    const pct = st.railWidthMode === 'manual' ? clamp(st.railWidth, 20, 100) : autoCrossPct();
    cross = Math.round(cspan * pct / 100);
    let pos = PAD;
    layout = items.map((it) => {
      const ext = Math.max(24, Math.round(cross * mainAspect(it)));
      const box = { pos, ext };
      pos += ext + st.gap;
      return box;
    });
    total = (items.length ? pos - st.gap : pos) + PAD;
    maxScroll = Math.max(0, total - mspan);
    P = clamp(P, 0, maxScroll);
    T = clamp(T, 0, maxScroll);
    dirty = true;
    lastRange = [0, -1]; // force remount pass
    for (const [idx, elm] of mounted) positionEl(idx, elm);
  }

  function relayoutPreservingAnchor() {
    // Anchor against the OLD layout/span (mspan is recomputed inside
    // computeLayout), then re-derive P from the new one.
    const anchor = itemAt(P + mspan * 0.4);
    const frac = anchor !== null && layout[anchor]
      ? (P + mspan * 0.4 - layout[anchor].pos) / Math.max(1, layout[anchor].ext)
      : 0;
    computeLayout();
    if (anchor !== null && layout[anchor]) {
      P = clamp(layout[anchor].pos + frac * layout[anchor].ext - mspan * 0.4, 0, maxScroll);
      T = P;
    }
    // Rebase an active drag so its next pointermove continues from the new P.
    if (drag) drag.startP = P + (drag.lastM - drag.m0);
    // An in-flight step glide holds pre-relayout coordinates — rebase it.
    if (stepState?.phase === 'move') {
      stepState.from = P;
      stepState.to = stopPos(stepState.idx);
      stepState.t = 0;
    }
    dirty = true;
    kick();
  }

  // Corrects an item's real aspect once media metadata arrives; shifts the
  // layout after it and compensates P so nothing visibly jumps.
  function correctAspect(idx, w, h) {
    if (!w || !h) return;
    const it = items[idx];
    if (it.w === w && it.h === h) return;
    it.w = w;
    it.h = h;
    const newExt = Math.max(24, Math.round(cross * mainAspect(it)));
    const delta = newExt - layout[idx].ext;
    if (delta === 0) return;
    // Compensate against the OLD extent: if the item was previously before the
    // viewport, everything visible shifts by delta, so P must follow — even
    // when the item's new end now crosses into view.
    const oldEnd = layout[idx].pos + layout[idx].ext;
    layout[idx].ext = newExt;
    for (let k = idx + 1; k < layout.length; k++) layout[k].pos += delta;
    total += delta;
    maxScroll = Math.max(0, total - mspan);
    if (oldEnd <= P) {
      P += delta;
      T += delta;
      // An active drag anchors P to startP — shift the anchor too, or the
      // next pointermove undoes this compensation under the finger.
      if (drag) drag.startP += delta;
    }
    P = clamp(P, 0, maxScroll);
    T = clamp(T, 0, maxScroll);
    for (const [k, elm] of mounted) positionEl(k, elm);
    if (stepState?.phase === 'move') {
      stepState.from = P;
      stepState.to = stopPos(stepState.idx);
      stepState.t = 0; // restart the ease from here — stale t would lurch P
    }
    dirty = true;
    kick();
  }

  // Binary search: index of the item covering worldPos (or nearest before).
  function itemAt(worldPos) {
    if (!layout.length) return null;
    let lo = 0, hi = layout.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (layout[mid].pos <= worldPos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // Scroll position that centers item i in the viewport.
  const stopPos = (idx) =>
    clamp(layout[idx].pos - Math.max(0, (mspan - layout[idx].ext) / 2), 0, maxScroll);

  const centerIndex = () => itemAt(P + mspan / 2) ?? 0;

  // ---- virtualized rendering ---------------------------------------------

  function positionEl(idx, elm) {
    const box = layout[idx];
    if (horiz) {
      elm.style.left = `${box.pos}px`;
      elm.style.width = `${box.ext}px`;
      elm.style.height = `${cross}px`;
      elm.style.marginTop = `${-cross / 2}px`;
    } else {
      elm.style.top = `${box.pos}px`;
      elm.style.height = `${box.ext}px`;
      elm.style.width = `${cross}px`;
      elm.style.marginLeft = `${-cross / 2}px`;
    }
  }

  function buildItem(idx) {
    const it = items[idx];
    const elm = el('div', { class: 'rail-item', 'data-i': String(idx) });
    positionEl(idx, elm);
    if (it.type === 'video') {
      const v = el('video', {
        controls: '', playsinline: '', preload: 'metadata',
        src: api.mediaUrl(it),
      });
      v.addEventListener('loadedmetadata', () => {
        if (v.videoWidth) correctAspect(idx, v.videoWidth, v.videoHeight);
      }, { once: true });
      v.addEventListener('play', () => stopPlaying());
      elm.append(v);
    } else {
      const img = el('img', {
        decoding: 'async', draggable: 'false', alt: it.name,
        // Thumbs are width-bucketed: the item's CSS width is `cross` when
        // vertical but its main extent when horizontal.
        src: api.thumbUrl(it, horiz ? layout[idx].ext : cross),
      });
      const onload = () => {
        img.classList.add('on');
        // Always reconcile with what the browser will actually paint: probed
        // dims can be wrong (EXIF-rotated files, odd formats). Same aspect
        // ratio → delta 0 → no-op, so the common case costs nothing.
        correctAspect(idx, img.naturalWidth, img.naturalHeight);
      };
      // queueMicrotask so a memory-cached (synchronously complete) image
      // corrects only after this element is registered in `mounted`.
      if (img.complete && img.naturalWidth) queueMicrotask(onload);
      else img.addEventListener('load', onload, { once: true });
      elm.append(img);
    }
    return elm;
  }

  function render() {
    const px = -Math.round(P * 100) / 100;
    canvas.style.transform = horiz
      ? `translate3d(${px}px,0,0)`
      : `translate3d(0,${px}px,0)`;

    const nearEdge = P - mspan * BUFFER_VP;
    const farEdge = P + mspan * (1 + BUFFER_VP);
    let first = itemAt(nearEdge) ?? 0;
    if (layout[first] && layout[first].pos + layout[first].ext < nearEdge) first++;
    let last = itemAt(farEdge) ?? -1;

    if (first !== lastRange[0] || last !== lastRange[1]) {
      lastRange = [first, last];
      for (const [idx, elm] of mounted) {
        if (idx < first || idx > last) {
          elm.querySelector('video')?.pause();
          elm.remove();
          mounted.delete(idx);
        }
      }
      for (let idx = first; idx <= last && idx < items.length; idx++) {
        if (!mounted.has(idx)) {
          const elm = buildItem(idx);
          mounted.set(idx, elm);
          canvas.append(elm);
        }
      }
    }

    if (total > mspan && sbTrack > 0) {
      const size = clamp((mspan / total) * sbTrack, 28, sbTrack);
      const travel = sbTrack - size;
      const off = maxScroll > 0 ? (P / maxScroll) * travel : 0;
      if (horiz) {
        sbThumb.style.width = `${size}px`;
        sbThumb.style.left = `${off}px`;
      } else {
        sbThumb.style.height = `${size}px`;
        sbThumb.style.top = `${off}px`;
      }
    }
  }

  // ---- engine loop --------------------------------------------------------

  function kick() {
    if (!raf) {
      lastT = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  function tick(now) {
    raf = 0;
    const dt = clamp((now - lastT) / 1000, 0, 0.05);
    lastT = now;
    const before = P;

    if (mode === 'drag') {
      // P is set directly by the pointer handlers
    } else if (returning) {
      const d = 0 - P;
      P += d * (1 - Math.exp(-dt * GLIDE_RATE * 1.6));
      if (Math.abs(d) < 1) {
        P = 0;
        returning = false;
        if (playing) beginPattern();
      }
    } else if (playing) {
      advancePlay(dt);
    } else if (mode === 'inertia') {
      P += V * dt;
      V *= Math.exp(-dt * FRICTION);
      if (P <= 0 || P >= maxScroll) { P = clamp(P, 0, maxScroll); V = 0; }
      if (Math.abs(V) < MIN_VEL) { mode = 'idle'; V = 0; T = P; }
    } else {
      const d = T - P;
      if (Math.abs(d) > 0.08) P += d * (1 - Math.exp(-dt * GLIDE_RATE));
      else P = T;
    }

    P = clamp(P, 0, maxScroll);
    if (P !== before || dirty) {
      dirty = false;
      render();
      showScrollbar();
    }

    const active =
      mode !== 'idle' || playing || returning || Math.abs(T - P) > 0.08 || dirty;
    if (active) raf = requestAnimationFrame(tick);
  }

  // ---- playback patterns --------------------------------------------------

  function beginPattern() {
    stepState = null;
    if (st.pattern === 'step') {
      const idx = centerIndex();
      stepState = { phase: 'move', t: 0, from: P, to: stopPos(idx), idx };
    }
  }

  function advancePlay(dt) {
    if (st.pattern === 'cruise') {
      P += st.speed * dt * playDir;
    } else if (st.pattern === 'breathe') {
      const c = P + mspan / 2;
      const idx = itemAt(c) ?? 0;
      const box = layout[idx];
      const center = box.pos + box.ext / 2;
      const d = Math.abs(c - center) / Math.max(1, box.ext / 2 + st.gap);
      const f = 0.12 + 0.88 * Math.pow(clamp(d, 0, 1), 1.4);
      P += st.speed * f * dt * playDir;
    } else if (st.pattern === 'step') {
      if (!stepState) beginPattern();
      const s = stepState;
      s.t += dt;
      if (s.phase === 'move') {
        const k = easeInOutCubic(clamp(s.t / Math.max(0.15, st.ease), 0, 1));
        P = s.from + (s.to - s.from) * k;
        if (k >= 1) { s.phase = 'dwell'; s.t = 0; }
      } else if (s.t >= st.dwell) {
        const nextIdx = s.idx + playDir;
        if (nextIdx < 0 || nextIdx >= items.length) {
          handleEnd();
          return;
        }
        stepState = { phase: 'move', t: 0, from: P, to: stopPos(nextIdx), idx: nextIdx };
      }
      return; // step handles its own end via index bounds
    }
    if ((playDir > 0 && P >= maxScroll) || (playDir < 0 && P <= 0)) handleEnd();
  }

  function handleEnd() {
    if (st.loop === 'bounce') {
      playDir *= -1;
      if (st.pattern === 'step' && stepState) {
        const nextIdx = clamp(stepState.idx + playDir, 0, items.length - 1);
        stepState = { phase: 'move', t: 0, from: P, to: stopPos(nextIdx), idx: nextIdx };
      }
      return;
    }
    if (st.loop === 'restart' && playDir > 0) {
      returning = true;
      stepState = null;
      return;
    }
    stopPlaying();
    P = clamp(P, 0, maxScroll);
    T = P;
  }

  function startPlaying() {
    if (!items.length) return;
    playing = true;
    playDir = 1;
    returning = false;
    mode = 'idle';
    V = 0;
    T = P;
    if (P >= maxScroll - 1 && maxScroll > 0 && st.loop !== 'bounce') {
      returning = true; // already at the end: glide home first, then play
    } else {
      beginPattern();
    }
    playFab.innerHTML = icons.pause;
    playFab.classList.add('playing');
    if (st.autohide) scheduleHide(900);
    kick();
  }

  function stopPlaying() {
    if (!playing && !returning) return;
    playing = false;
    returning = false;
    stepState = null;
    T = P;
    playFab.innerHTML = icons.play;
    playFab.classList.remove('playing');
    showChrome();
  }

  playFab.addEventListener('click', (e) => {
    e.stopPropagation();
    playing ? stopPlaying() : startPlaying();
  });

  // ---- chrome auto-hide ---------------------------------------------------

  let hideTimer = 0;
  let sbTimer = 0;

  function showChrome() {
    bar.classList.remove('hidden');
    playFab.classList.remove('hidden');
    rail.style.cursor = '';
    clearTimeout(hideTimer);
    if (st.autohide) scheduleHide(2200);
  }

  function scheduleHide(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      bar.classList.add('hidden');
      playFab.classList.add('hidden');
      if (playing) rail.style.cursor = 'none';
    }, ms);
  }

  function showScrollbar() {
    if (total <= mspan) return;
    scrollbar.classList.add('on');
    clearTimeout(sbTimer);
    sbTimer = setTimeout(() => scrollbar.classList.remove('on'), 1100);
  }

  rail.addEventListener('pointermove', showChrome, { passive: true });

  // ---- wheel --------------------------------------------------------------

  rail.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (isSheetOpen()) return;
    if (mode === 'drag') return;
    // Horizontal rail: the wheel still scrolls the rail (deltaY), and trackpad
    // sideways swipes (deltaX) ride along.
    let d = horiz ? e.deltaY + e.deltaX : e.deltaY;
    if (e.deltaMode === 1) d *= 18;          // lines → px
    else if (e.deltaMode === 2) d *= mspan;  // pages → px
    stopPlaying();
    // T goes stale while inertia (or playback) moves P directly — resync
    // before accumulating, or the glide would jump back to a pre-drag spot.
    if (mode === 'inertia') { mode = 'idle'; V = 0; T = P; }
    T = clamp(T + d, 0, maxScroll);
    kick();
  }, { passive: false });

  // ---- drag ---------------------------------------------------------------

  let drag = null;
  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.rail-bar, .rail-play-fab, .rail-scrollbar')) return;
    drag = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      m0: mainOf(e),
      lastM: mainOf(e),
      startP: P,
      samples: [{ t: performance.now(), m: mainOf(e) }],
      moved: false,
      // Drags may START on a video (it can fill the whole viewport), but a
      // motionless tap there belongs to the video's own controls.
      fromVideo: !!e.target.closest('video'),
      // A tap during auto-play should only pause it — never leak into
      // viewer navigation.
      wasPlaying: playing || returning,
    };
    stopPlaying();
    mode = 'drag';
    V = 0;
    T = P; // resync the glide target so later wheel/keys don't jump back
    kick();
  });

  rail.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // A mouse released outside the window before capture engaged leaves a
    // dead gesture behind — detect the missing button and reset.
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) {
      drag = null;
      mode = 'idle';
      T = P;
      return;
    }
    const dm = mainOf(e) - drag.m0;
    drag.lastM = mainOf(e);
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) {
      drag.moved = true;
      // Capture only once it IS a drag — capturing on pointerdown would
      // retarget the tap's click away from video controls.
      rail.setPointerCapture(drag.id);
    }
    if (drag.moved) {
      P = clamp(drag.startP - dm, 0, maxScroll);
      dirty = true; // P changed outside tick — the render gate can't see it
      const now = performance.now();
      drag.samples.push({ t: now, m: mainOf(e) });
      while (drag.samples.length > 2 && now - drag.samples[0].t > 110) drag.samples.shift();
      kick();
    }
  });

  const endPointer = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      mode = 'idle';
      T = P;
      if (d.wasPlaying) { showChrome(); return; } // tap during play = pause only
      if (!d.fromVideo && e.type !== 'pointercancel') handleTap(e);
      return;
    }
    const now = performance.now();
    const s0 = d.samples[0];
    const sN = d.samples[d.samples.length - 1];
    const span = Math.max(1, sN.t - s0.t);
    const vel = (-(sN.m - s0.m) / span) * 1000;
    if (Math.abs(vel) > 60 && now - sN.t < 90) {
      mode = 'inertia';
      V = vel;
    } else {
      mode = 'idle';
      T = P;
    }
    kick();
  };
  // On window, not rail: before capture engages (first 6px) a release outside
  // the browser window would otherwise never reach us, stranding mode='drag'.
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  function handleTap(e) {
    const world = P + mainOf(e);
    const idx = itemAt(world);
    if (idx !== null) {
      const box = layout[idx];
      const near = (cspan - cross) / 2;
      const c = crossOf(e);
      if (
        world >= box.pos && world <= box.pos + box.ext &&
        c >= near && c <= near + cross
      ) {
        session.viewerFrom = 'rail';
        go(`#/v/${colId}/${idx}`);
        return;
      }
    }
    // tap outside any image toggles chrome
    if (bar.classList.contains('hidden')) showChrome();
    else scheduleHide(0);
  }

  // ---- scrollbar dragging -------------------------------------------------

  let sbDrag = null;
  scrollbar.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    stopPlaying();
    sbDrag = e.pointerId;
    scrollbar.setPointerCapture(e.pointerId);
    scrollbar.classList.add('drag');
    seekScrollbar(e);
  });
  scrollbar.addEventListener('pointermove', (e) => {
    if (sbDrag === e.pointerId) seekScrollbar(e);
  });
  const endSb = (e) => {
    if (sbDrag !== e.pointerId) return;
    sbDrag = null;
    scrollbar.classList.remove('drag');
  };
  scrollbar.addEventListener('pointerup', endSb);
  scrollbar.addEventListener('pointercancel', endSb);

  function seekScrollbar(e) {
    const rect = scrollbar.getBoundingClientRect();
    const size = parseFloat(horiz ? sbThumb.style.width : sbThumb.style.height) || 28;
    const along = horiz ? e.clientX - rect.left : e.clientY - rect.top;
    const trackLen = horiz ? rect.width : rect.height;
    // Same travel mapping as render(), so the thumb tracks the pointer 1:1.
    const frac = clamp((along - size / 2) / Math.max(1, trackLen - size), 0, 1);
    P = T = frac * maxScroll;
    dirty = true; // P changed outside tick — force a repaint
    mode = 'idle';
    V = 0;
    kick();
  }

  // ---- keyboard -----------------------------------------------------------

  // Bindings are axis-independent on purpose: Down/PageDown always move
  // forward along the rail, Left/Right always snap between images.
  function onKey(e) {
    if (isSheetOpen()) return;
    if (mode === 'drag') return; // the pointer owns P while a drag is live
    const stopAnd = (fn) => {
      e.preventDefault();
      stopPlaying();
      if (mode !== 'idle') { mode = 'idle'; V = 0; T = P; } // resync stale target
      fn();
      kick();
    };
    switch (e.key) {
      case 'ArrowDown': stopAnd(() => { T = clamp(T + mspan * 0.16, 0, maxScroll); }); break;
      case 'ArrowUp': stopAnd(() => { T = clamp(T - mspan * 0.16, 0, maxScroll); }); break;
      case 'PageDown': stopAnd(() => { T = clamp(T + mspan * 0.88, 0, maxScroll); }); break;
      case 'PageUp': stopAnd(() => { T = clamp(T - mspan * 0.88, 0, maxScroll); }); break;
      case 'Home': stopAnd(() => { T = 0; }); break;
      case 'End': stopAnd(() => { T = maxScroll; }); break;
      case 'ArrowRight': stopAnd(() => { T = stopPos(clamp(centerIndex() + 1, 0, items.length - 1)); }); break;
      case 'ArrowLeft': stopAnd(() => { T = stopPos(clamp(centerIndex() - 1, 0, items.length - 1)); }); break;
      case 'b': e.preventDefault(); setBookmark(); break;
      case ' ': e.preventDefault(); playing ? stopPlaying() : startPlaying(); break;
      case 'Escape': e.preventDefault(); toGrid(); break;
      case 'Enter': {
        e.preventDefault();
        const idx = centerIndex();
        session.viewerFrom = 'rail';
        go(`#/v/${colId}/${idx}`);
        break;
      }
    }
  }
  window.addEventListener('keydown', onKey);

  // ---- resize -------------------------------------------------------------

  let resizeRaf = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(relayoutPreservingAnchor);
  };
  window.addEventListener('resize', onResize);

  // ---- load ---------------------------------------------------------------

  (async () => {
    // Consume the autoplay intent up front so a failed load can't leave it
    // armed for some unrelated later rail visit.
    const wantAutoplay = session.railAutoplay;
    session.railAutoplay = false;
    let data;
    try {
      data = await loadCollection(colId);
    } catch (err) {
      if (alive) { toast(err.message, { error: true }); go('#/'); }
      return;
    }
    if (!alive) return;
    barTitle.textContent = data.name;
    items = data.items.map((it) => ({ ...it }));
    computeLayout();
    if (startIndex !== null && layout[startIndex]) {
      P = T = stopPos(startIndex);
      // Drop the index from the URL so a remount (e.g. after a rescan from
      // the Setup sheet) resumes from the saved position, not the entry image.
      history.replaceState(null, '', `#/r/${colId}`);
    } else if (session.railPos.has(posKey())) {
      P = T = clamp(session.railPos.get(posKey()), 0, maxScroll);
    }
    dirty = true;
    kick();
    showChrome();
    if (wantAutoplay) startPlaying();
  })();

  return () => {
    alive = false;
    session.railPos.set(posKey(), P);
    unsub();
    cancelAnimationFrame(raf);
    cancelAnimationFrame(resizeRaf);
    clearTimeout(hideTimer);
    clearTimeout(sbTimer);
    for (const [, elm] of mounted) elm.querySelector('video')?.pause();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointerup', endPointer);
    window.removeEventListener('pointercancel', endPointer);
    document.body.style.overflow = '';
  };
}
