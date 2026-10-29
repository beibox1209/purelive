'use strict';

const path = require('path');
const { BrowserWindow, shell, clipboard, screen } = require('electron');
const { publicPlatform, PLATFORMS, PLATFORM_MAP } = require('./platforms');

function fittedBounds(saved, defaultWidth, defaultHeight) {
  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.max(900, Math.min(saved?.width || defaultWidth, work.width - 36));
  const height = Math.max(580, Math.min(saved?.height || defaultHeight, work.height - 36));
  let x = Number.isFinite(saved?.x) ? saved.x : work.x + Math.round((work.width - width) / 2);
  let y = Number.isFinite(saved?.y) ? saved.y : work.y + Math.round((work.height - height) / 2);
  x = Math.max(work.x + 8, Math.min(x, work.x + work.width - width - 8));
  y = Math.max(work.y + 8, Math.min(y, work.y + work.height - height - 8));
  return { width, height, x, y };
}

function platformOf(room) {
  return PLATFORM_MAP.get(room.platform) || PLATFORM_MAP.get('generic');
}

function fallbackName(room) {
  const p = platformOf(room);
  try {
    const u = new URL(room.url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    if (/^\d{3,}$/.test(seg)) return `${p.name} · ${seg}`;
  } catch {}
  return `${p.name} · 直播间`;
}

class LibraryWindow {
  constructor({ store, thumbnails }) {
    this.store = store;
    this.thumbnails = thumbnails;
    this.win = null;
    this.appVersion = '';
  }

  create() {
    if (this.win && !this.win.isDestroyed()) {
      this.focus();
      return;
    }
    const saved = this.store.getWindowState('libraryWindow');
    const bounds = fittedBounds(saved, 1180, 780);
    this.win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: 940,
      minHeight: 620,
      show: false,
      backgroundColor: '#080b10',
      title: '净播 PureLive',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#080b10', symbolColor: '#aeb8c8', height: 48 },
      webPreferences: {
        preload: path.join(__dirname, 'library-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.win.setMenuBarVisibility(false);
    if (saved?.maximized) this.win.maximize();
    this.win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
    let shown = false;
    const reveal = () => {
      if (shown || !this.win || this.win.isDestroyed()) return;
      shown = true;
      this.win.show();
    };
    this.win.webContents.once('dom-ready', reveal);
    this.win.once('ready-to-show', reveal);
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.on('close', () => {
      if (!this.win.isFullScreen()) {
        const b = this.win.getBounds();
        this.store.setWindowState('libraryWindow', { ...b, maximized: this.win.isMaximized() });
      }
    });
    this.win.on('closed', () => { this.win = null; });
    this.win.on('restore', () => this.sendState());
  }

  focus() {
    if (!this.win || this.win.isDestroyed()) return this.create();
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  serializeRoom(room) {
    const p = platformOf(room);
    return {
      id: room.id,
      url: room.url,
      name: room.name,
      displayName: room.name || fallbackName(room),
      platform: room.platform,
      platformInfo: publicPlatform(p),
      favorite: room.favorite,
      createdAt: room.createdAt,
      lastOpenedAt: room.lastOpenedAt,
      preview: this.thumbnails.preview(room.id),
    };
  }

  serializeState() {
    return {
      rooms: this.store.sortRooms(this.store.getRooms()).map((r) => this.serializeRoom(r)),
      settings: this.store.getSettings(),
      platforms: PLATFORMS.map((p) => publicPlatform(p)),
      version: this.appVersion,
    };
  }

  sendState() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('library:state', this.serializeState());
    }
  }

  copy(text) {
    clipboard.writeText(String(text || ''));
  }

  openExternal(url) {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
  }
}

module.exports = { LibraryWindow, fallbackName };
