// Server API client + media URL helpers.

async function j(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

export const getState = () => j('/api/collections');
export const getStatus = () => j('/api/status');
export const getCollection = (id) => j('/api/collection?id=' + encodeURIComponent(id));
export const rescan = () => j('/api/rescan', { method: 'POST' });
export const saveConfig = (cfg) =>
  j('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });

export const browseFs = (p) =>
  j('/api/fs' + (p ? '?path=' + encodeURIComponent(p) : ''));

// Poll /api/status while a scan runs; returns a stop function.
export function watchScan(onTick, ms = 300) {
  let stopped = false;
  let inFlight = false; // skip ticks while one is pending — a stalled response
  const timer = setInterval(async () => { // must never overwrite a newer one
    if (inFlight) return;
    inFlight = true;
    try {
      const s = await getStatus();
      if (!stopped) onTick(s);
    } catch {
      // server busy/unreachable — keep polling until stopped
    } finally {
      inFlight = false;
    }
  }, ms);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export const fmtProgress = (pr) =>
  pr.phase === 'walk'
    ? `Scanning… ${pr.files.toLocaleString()} files in ${pr.dirs.toLocaleString()} folders`
    : `Reading dimensions… ${pr.probed.toLocaleString()} / ${pr.total.toLocaleString()}`;

export const mediaUrl = (it) => `/media/${it.id}?v=${it.v}`;

// Server snaps widths to fixed buckets; mirror them so URLs cache well.
const BUCKETS = [320, 640, 960, 1440, 1920, 2560];

export function thumbUrl(it, cssPx) {
  const target = (cssPx || 640) * Math.min(window.devicePixelRatio || 1, 2);
  let w = BUCKETS[BUCKETS.length - 1];
  for (const b of BUCKETS) {
    if (target <= b) { w = b; break; }
  }
  return `/thumb/${it.id}?w=${w}&v=${it.v}`;
}

// Largest generated thumbnail — the viewer's upgrade target when the original
// is too large to decode comfortably.
export const maxThumbUrl = (it) =>
  `/thumb/${it.id}?w=${BUCKETS[BUCKETS.length - 1]}&v=${it.v}`;
