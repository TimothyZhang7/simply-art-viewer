// Desktop shell: runs the existing HTTP server in Electron's main process and
// opens a window on it. The server binds an ephemeral localhost port, so the
// desktop app never collides with a `npm start` instance.

import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Must be set before server.js is imported — it resolves paths at import.
  process.env.SAV_DESKTOP = '1';
  process.env.SAV_DATA_DIR = app.getPath('userData');
  // The port must be STABLE across launches: client prefs (settings,
  // favourites, bookmarks) live in localStorage, which is scoped to
  // scheme+host+port — an ephemeral port would wipe them on every start.
  // 34877 is distinct from the dev server's 4877, so both can run at once.
  process.env.SAV_PORT = '34877';
  app.setAppUserModelId('com.simplyartviewer.desktop');

  const boundsPath = () => path.join(app.getPath('userData'), 'window-state.json');
  let win = null;

  async function createWindow() {
    const { server } = await import('../server.js');
    const port = await new Promise((resolve, reject) => {
      if (server.listening) return resolve(server.address().port);
      server.once('listening', () => resolve(server.address().port));
      server.once('error', (err) => {
        // Some other software owns the stable port — fall back to an
        // ephemeral one so the app still opens. Prefs are isolated for such
        // a run (different origin), which beats not launching at all.
        if (err.code === 'EADDRINUSE') {
          server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        } else {
          reject(err);
        }
      });
    });

    let bounds = {};
    try {
      bounds = JSON.parse(await readFile(boundsPath(), 'utf8'));
    } catch {
      // first run
    }
    win = new BrowserWindow({
      width: bounds.width || 1400,
      height: bounds.height || 900,
      x: bounds.x,
      y: bounds.y,
      minWidth: 480,
      minHeight: 360,
      backgroundColor: '#0b0c0f', // matches --bg; avoids a white flash
      // No native title bar — the OS draws only min/max/close, themed to the
      // app, and the app's own header doubles as the drag region.
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0b0c0f', symbolColor: '#e8eaf0', height: 55 },
      icon: path.join(app.getAppPath(), 'build', 'icon.png'),
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    if (bounds.maximized) win.maximize();

    win.on('close', () => {
      // Fire-and-forget: the window is gone either way.
      const b = win.getNormalBounds();
      writeFile(boundsPath(), JSON.stringify({ ...b, maximized: win.isMaximized() })).catch(() => {});
    });
    win.loadURL(`http://127.0.0.1:${port}`);
  }

  // Frameless windows never show a menu bar, but an application menu is still
  // what registers accelerators — fullscreen must always work.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' }, // F11
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'editMenu' }, // clipboard shortcuts for the Setup inputs
  ]));

  app.whenReady().then(createWindow);
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
}
