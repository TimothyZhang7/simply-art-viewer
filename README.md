# Simply Art Viewer

A fluid, minimal local art gallery. Point it at a folder — every subfolder
holding a few images becomes a collection (videos in the folder, or in a
subfolder of it, ride along). Browse in a justified grid, a full-screen
click-zone viewer, or the **rail**: the whole collection on one continuous
canvas with buttery smooth scrolling and configurable auto-play patterns.

## Run

```
npm install     # optional but recommended: installs sharp for fast thumbnails
npm start       # → http://127.0.0.1:4877
```

Optional: `node server.js "D:\Pictures" --port 4877 --host 127.0.0.1`
(set `host` to `0.0.0.0` in `config.json` to reach it from other devices —
be aware that exposes your library to your network).

## Desktop app

```
npm install
npm run app     # launch as a desktop window (dev)
npm run dist    # build the Windows installer into dist/
```

The desktop build wraps the same server in Electron: it binds an ephemeral
localhost port (so it never collides with a running `npm start`), and keeps
its own config + thumbnail cache under `%APPDATA%\Simply Art Viewer` instead
of the app folder. Window size/position are remembered between runs.

Everything else is configured in the app under **Setup** (gear icon) — the
scan folder can be picked with the built-in folder browser (Browse button) or
typed directly. Thumbnails and scan manifests are cached in `.savcache/`.

## Navigation

**Home** — the ★ on a collection card marks it a favourite; favourites stay
anchored to the top of the grid.

**Viewer** (click any image)
- click **left / right** edges → previous / next
- click **top** → back to the collection
- click **bottom** → open Setup
- arrows / Esc, swipe on touch, `f` fullscreen, `r` rail, `Space` rail + play

**Rail** (single-canvas mode)
- mouse wheel, trackpad, arrow / PageUp / PageDown / Home / End keys,
  or grab and throw — all with smooth inertial motion
- runs vertically or **horizontally** (images side by side — made for portrait
  sets); flip direction from the rail's top bar or in Setup
- image size auto-fits the collection's dominant image shape (portrait sets
  get a narrower column, landscape sets fill the screen); switch to Manual
  in Setup for an exact size
- `←`/`→` snap to previous / next image, `Enter` opens the viewer, `Esc` back
- `b` (or the bookmark button) saves one spot per collection; the filled
  bookmark button glides back to it — bookmarks survive restarts
- **Play** (or `Space`) auto-scrolls with your chosen pattern:
  - **Cruise** — constant glide, configurable speed
  - **Step** — eases image-to-image, dwelling on each
  - **Breathe** — slows near each image, accelerates between
  - end behavior: stop, restart from the top, or bounce

## Design notes

- Zero-framework backend (Node built-ins only); `sharp` is an *optional*
  dependency — without it the server streams originals instead of webp thumbs.
- The full-screen viewer paints a thumbnail instantly, then swaps in the
  original file once it has decoded off-thread (huge images cap at the largest
  thumbnail size). ICC profiles survive thumbnailing, so wide-gamut photos
  keep their colors.
- Image dimensions are probed from file headers (pure JS) at scan time and
  cached, so every layout is computed before a single pixel loads.
- The frontend is vanilla ES modules, no build step. The rail virtualizes the
  DOM (only visible items mounted) and renders through a single GPU transform
  per frame.
