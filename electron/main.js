'use strict';

const path = require('path');
const { app, ipcMain, Menu, shell, clipboard, session } = require('electron');
const { Store } = require('./store');
const { Thumbnails } = require('./thumbnails');
const { LibraryWindow, fallbackName } = require('./library-window');
const { PlayerWindow } = require('./player-window');
const { fetchPageTitle, fetchLiveCover, fetchImageBuffer } = require('./metadata');
const { PLATFORMS, PLATFORM_MAP, publicPlatform } = require('./platforms');

const isDev = process.argv.includes('--dev');
const chromeMajor = process.versions.chrome.split('.')[0];
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
global.__PURELIVE_UA__ = USER_AGENT;

app.setName('PureLive');
app.setAppUserModelId('com.purelive.player');
app.userAgentFallback = USER_AGENT;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let store;
  let thumbnails;
  let library;
  let player;

  function serializeRoom(room) {
    return library.serializeRoom(room);
  }

  function broadcast() {
    library.sendState();
  }

  const coverJobs = new Set();

  async function hydrateCover(roomId, force = false) {
    const room = store.getRoom(roomId);
    if (!room || !room.url) return false;
    if (!force && thumbnails.has(room.id)) return false;
    if (coverJobs.has(room.id)) return false;
    coverJobs.add(room.id);
    try {
      const imageUrl = await fetchLiveCover(room);
      if (!imageUrl) return false;
      const buffer = await fetchImageBuffer(imageUrl, room.url);
      if (!buffer) return false;
      const saved = thumbnails.saveBuffer(room.id, buffer);
      if (saved) broadcast();
      return saved;
    } catch {
      return false;
    } finally {
      coverJobs.delete(room.id);
    }
  }

  async function hydrateMissingCovers() {
    const rooms = store.getRooms().filter((r) => !thumbnails.has(r.id)).slice(0, 6);
    for (const room of rooms) {
      await hydrateCover(room.id);
      await new Promise((r) => setTimeout(r, 900));
    }
  }

  async function hydrateTitle(roomId) {
    const room = store.getRoom(roomId);
    if (!room || room.nameLocked || room.name) return;
    const title = await fetchPageTitle(room.url);
    if (!title) return;
    if (store.setAutoName(roomId, title)) {
      broadcast();
      if (player && player.room && player.room.id === roomId) {
        player.room = store.getRoom(roomId) || player.room;
        if (player.win && !player.win.isDestroyed()) player.win.setTitle(player.room.name);
        player.sendState();
      }
    }
  }

  function cookieMatchesPlatform(cookie, platform) {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    const hosts = [...(platform.hosts || [])];
    if (platform.id === 'youtube') hosts.push('google.com');
    return hosts.some((h) => domain === h || domain.endsWith('.' + h));
  }

  async function getAccounts() {
    const ses = session.fromPartition('persist:purelive');
    const cookies = await ses.cookies.get({});
    return PLATFORMS.filter((p) => p.loginUrl).map((p) => {
      const names = new Set(p.cookieNames || []);
      const found = cookies.filter((c) => cookieMatchesPlatform(c, p) && names.has(c.name) && c.value);
      return {
        ...publicPlatform(p),
        loggedIn: found.length > 0,
        loginUrl: p.loginUrl,
      };
    });
  }

  async function logoutAccount(platformId) {
    const platform = PLATFORM_MAP.get(platformId);
    if (!platform || !platform.loginUrl) return { ok: false };
    const ses = session.fromPartition('persist:purelive');
    const cookies = await ses.cookies.get({});
    for (const cookie of cookies) {
      if (!cookieMatchesPlatform(cookie, platform)) continue;
      const host = String(cookie.domain || '').replace(/^\./, '');
      const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
      try { await ses.cookies.remove(url, cookie.name); } catch {}
    }
    const origins = new Set([
      platform.loginUrl,
      ...(platform.hosts || []).map((h) => 'https://' + h),
    ]);
    for (const origin of origins) {
      try { await ses.clearStorageData({ origin, storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'websql', 'serviceworkers'] }); } catch {}
    }
    try { await ses.flushStorageData(); } catch {}
    return { ok: true };
  }

  function registerIpc() {
    ipcMain.handle('library:get-state', () => library.serializeState());

    ipcMain.handle('library:add-room', (_event, payload = {}) => {
      try {
        const room = store.addRoom({ url: payload.url, name: payload.name });
        broadcast();
        if (!room.name) hydrateTitle(room.id);
        hydrateCover(room.id);
        return { ok: true, room: serializeRoom(room) };
      } catch (e) {
        return {
          ok: false,
          code: e.code || 'ERROR',
          error: e.message || '添加失败',
          room: e.room ? serializeRoom(e.room) : null,
        };
      }
    });

    ipcMain.handle('library:update-room', (_event, id, patch = {}) => {
      try {
        const old = store.getRoom(id);
        if (!old) return { ok: false, error: '直播间不存在' };
        const oldUrl = old.url;
        const room = store.updateRoom(id, patch);
        if (patch.url !== undefined && room.url !== oldUrl && !room.nameLocked) {
          room.name = '';
          store.save();
        }
        broadcast();
        if (!room.name && !room.nameLocked) hydrateTitle(room.id);
        if (patch.url !== undefined && room.url !== oldUrl) hydrateCover(room.id, true);
        return { ok: true, room: serializeRoom(room) };
      } catch (e) {
        return { ok: false, code: e.code || 'ERROR', error: e.message || '保存失败' };
      }
    });

    ipcMain.handle('library:remove-room', (_event, id) => {
      const room = store.getRoom(id);
      const removed = store.removeRoom(id);
      if (removed) {
        thumbnails.remove(id);
        if (player && player.room && player.room.id === id) player.close();
        broadcast();
      }
      return { ok: removed, room: room ? serializeRoom(room) : null };
    });

    ipcMain.handle('library:toggle-favorite', (_event, id) => {
      const room = store.getRoom(id);
      if (!room) return { ok: false };
      store.updateRoom(id, { favorite: !room.favorite });
      broadcast();
      return { ok: true, favorite: !room.favorite };
    });

    ipcMain.handle('library:open-room', (_event, id) => {
      const room = store.getRoom(id);
      if (!room) return { ok: false, error: '直播间不存在' };
      player.open(room);
      hydrateCover(room.id);
      broadcast();
      return { ok: true };
    });

    ipcMain.handle('library:open-external', (_event, url) => {
      library.openExternal(url);
      return { ok: true };
    });

    ipcMain.handle('library:copy', (_event, text) => {
      library.copy(text);
      return { ok: true };
    });

    ipcMain.handle('library:paste', () => clipboard.readText());

    ipcMain.handle('library:open-data-folder', async () => {
      await shell.openPath(app.getPath('userData'));
      return { ok: true };
    });

    ipcMain.handle('library:get-accounts', async () => ({ ok: true, accounts: await getAccounts() }));

    ipcMain.handle('library:login-account', (_e, platformId) => {
      const ok = player.openLogin(platformId);
      if (!ok) return { ok: false, error: '暂不支持这个平台的账号登录' };
      setTimeout(() => library.sendState(), 400);
      return { ok: true };
    });

    ipcMain.handle('library:logout-account', async (_e, platformId) => {
      const result = await logoutAccount(platformId);
      return { ...result, accounts: await getAccounts() };
    });

    ipcMain.handle('library:set-setting', (_event, patch = {}) => {
      const settings = store.setSettings(patch);
      broadcast();
      return { ok: true, settings };
    });

    ipcMain.handle('player:get-state', () => player.getState());
    ipcMain.handle('player:toggle-clean', () => { player.toggleClean(); return player.getState(); });
    ipcMain.handle('player:set-clean', (_e, value) => { player.setClean(!!value); return player.getState(); });
    ipcMain.handle('player:reload', () => { player.reload(); return player.getState(); });
    ipcMain.handle('player:retry', () => { player.reload(); return player.getState(); });
    ipcMain.handle('player:toggle-play', () => { player.togglePlay(); return player.getState(); });
    ipcMain.handle('player:toggle-mute', () => { player.toggleMute(); return player.getState(); });
    ipcMain.handle('player:refresh-quality', async () => { await player.refreshQualities(true); return player.getState(); });
    ipcMain.handle('player:set-quality', async (_e, id) => { await player.setQuality(String(id)); return player.getState(); });
    ipcMain.handle('player:show-quality-menu', async (_e, position) => { await player.showQualityMenu(position || {}); return { ok: true }; });
    ipcMain.handle('player:show-more-menu', (_e, position) => { player.showMoreMenu(position || {}); return { ok: true }; });
    ipcMain.handle('player:toggle-enhance', async () => { await player.setEnhance(!player.enhance); return player.getState(); });
    ipcMain.handle('player:toggle-pin', () => { player.togglePin(); return player.getState(); });
    ipcMain.handle('player:toggle-fullscreen', () => { player.toggleFullscreen(); return player.getState(); });
    ipcMain.handle('player:copy-url', () => { player.copyUrl(); return { ok: true }; });
    ipcMain.handle('player:open-external', () => { player.openExternal(); return { ok: true }; });
    ipcMain.handle('player:close', () => { player.close(); return { ok: true }; });
    ipcMain.handle('player:devtools', () => { player.openDevTools(); return { ok: true }; });
    ipcMain.handle('player:home', () => {
      if (!player.room) return { ok: false };
      player.room = store.getRoom(player.room.id) || player.room;
      player.reload();
      return { ok: true };
    });
  }

  app.on('second-instance', () => {
    if (library) library.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    store = new Store(app.getPath('userData'));
    thumbnails = new Thumbnails(app.getPath('userData'));
    library = new LibraryWindow({ store, thumbnails });
    library.appVersion = app.getVersion();
    library.create();
    player = new PlayerWindow({
      store,
      thumbnails,
      host: library.win,
      onBack: () => library.focus(),
      onRoomsChanged: () => library.sendState(),
    });
    registerIpc();
    setTimeout(() => { hydrateMissingCovers().catch(() => {}); }, 6000);
    if (isDev) library.win?.webContents.openDevTools({ mode: 'detach' });
    app.on('activate', () => {
      if (library) library.focus();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    try { store?.saveNow(); } catch {}
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

process.on('uncaughtException', (e) => {
  console.error('[PureLive] uncaught', e);
});

