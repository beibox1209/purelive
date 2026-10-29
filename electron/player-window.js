'use strict';

const path = require('path');
const fs = require('fs');
const { BrowserWindow, WebContentsView, session, shell, clipboard, screen, Menu } = require('electron');
const { buildTheaterScript } = require('./theater');
const { publicPlatform, PLATFORM_MAP } = require('./platforms');

const HEADER_HEIGHT = 54;
const THEATER_WORLD_ID = 1001;
const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'passport.bilibili.com',
  'passport.douyu.com',
  'login.huya.com',
  'i.huya.com',
  'passport.twitch.tv',
  'www.douyin.com',
];

function debug(...args) {
  if (!process.env.PURELIVE_DEBUG) return;
  try {
    fs.appendFileSync(
      path.join(__dirname, '..', 'diag', 'player-debug.log'),
      new Date().toISOString() + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'
    );
  } catch {}
}

function fittedBounds(saved, defaultWidth, defaultHeight) {
  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.max(800, Math.min(saved?.width || defaultWidth, work.width - 36));
  const height = Math.max(500, Math.min(saved?.height || defaultHeight, work.height - 36));
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

function friendlyError(code, description) {  const map = {
    ERR_CONNECTION_TIMED_OUT: '连接超时，直播间暂时无法访问',
    ERR_NAME_NOT_RESOLVED: '找不到该网站，请检查链接是否正确',
    ERR_INTERNET_DISCONNECTED: '网络似乎断开了',
    ERR_CONNECTION_REFUSED: '对方服务器拒绝了连接',
    ERR_CONNECTION_RESET: '连接被重置，请稍后重试',
    ERR_BLOCKED_BY_RESPONSE: '该网站不允许被嵌入播放',
    ERR_TOO_MANY_REDIRECTS: '页面跳转次数过多',
    ERR_CERT_AUTHORITY_INVALID: '网站证书存在问题，已停止加载',
  };
  return map[code] || `页面加载失败${description ? '：' + description : ''}`;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timeout')), ms)),
  ]);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PlayerWindow {
  constructor({ store, thumbnails, onRoomsChanged, host, onBack }) {
    this.store = store;
    this.thumbnails = thumbnails;
    this.onRoomsChanged = onRoomsChanged;
    this.host = host || null;
    this.onBack = onBack || null;
    this.win = null;
    this.ui = null;
    this.view = null;
    this.room = null;
    this.clean = !!store.getSettings().clean;
    this.muted = false;
    this.pinned = false;
    this.ready = false;
    this.loading = false;
    this.error = null;
    this.mediaType = null;
    this.loadToken = 0;
    this.captureTimer = null;
    this.pollTimer = null;
    this.lastPaused = null;
    this.lastShownRoomId = null;
    this.viewLowered = false;
    this.theaterWorld = 'main';
    this.qualities = [];
    this.qualityCurrent = '';
    this.qualityLabel = '';
    this.qualityNote = '';
    this.qualityBusy = false;
    this.enhance = !!store.getSettings().enhance;
    this.aiMode = false;
    this.aiBusy = false;
    this.aiTimer = null;
    this.aiFrames = 0;
    this.aiFps = 0;
    this.aiFpsStart = 0;
    this.liveSession = session.fromPartition('persist:purelive');
    try {
      this.liveSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      this.liveSession.setPermissionCheckHandler(() => false);
    } catch {}
  }

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return;
    if (!this.host) throw new Error('Player host window is required');
    this.win = this.host;
    this.ui = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'player-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    this.ui.setBackgroundColor('#05070a');
    this.ui.setVisible(false);
    this.win.contentView.addChildView(this.ui);
    this.ui.webContents.loadFile(path.join(__dirname, '..', 'src', 'player.html'));
    this.win.on('resize', () => this.layout());
    this.win.on('maximize', () => this.layout());
    this.win.on('unmaximize', () => this.layout());
    this.win.on('enter-full-screen', () => {
      this.layout();
      this.sendState();
    });
    this.win.on('leave-full-screen', () => {
      this.layout();
      this.sendState();
    });
    this.win.on('closed', () => {
      this.stopTimers();
      if (this.view && !this.view.webContents.isDestroyed()) {
        try { this.view.webContents.close(); } catch {}
      }
      if (this.ui && !this.ui.webContents.isDestroyed()) {
        try { this.ui.webContents.close(); } catch {}
      }
      this.view = null;
      this.ui = null;
      this.win = null;
      this.room = null;
    });
    this.win.webContents.on('before-input-event', (event, input) => {
      if (this.room) this.handleShortcut(event, input);
    });
    this.ui.webContents.on('before-input-event', (event, input) => this.handleShortcut(event, input));
    this.ui.webContents.on('did-finish-load', () => this.sendState());
    this.createView();
  }

  createView() {
    if (!this.win || this.view) return;
    this.view = new WebContentsView({
      webPreferences: {
        partition: 'persist:purelive',
        preload: path.join(__dirname, 'guest-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.view.setBackgroundColor('#000000');
    this.win.contentView.addChildView(this.view);
    this.viewLowered = true;
    this.layout();
    this.applyAudio();
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('page-title-updated', (_e, title) => this.handlePageTitle(title));
    wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      this.onNavigationStarted();
    });
    wc.on('did-finish-load', () => debug('guest did-finish-load', wc.getURL()));
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.fail(friendlyError(code, desc));
    });
    wc.on('render-process-gone', () => this.fail('播放器进程意外退出，请重试'));
    wc.on('unresponsive', () => this.toast('页面响应较慢，仍在尝试播放'));
    wc.on('dom-ready', () => this.handleDomReady());
    wc.on('will-navigate', (e, url) => {
      if (!this.room) return;
      if (this.isAllowedNavigation(url)) return;
      e.preventDefault();
      this.toast('已阻止离开当前直播间');
    });
    wc.on('before-input-event', (event, input) => this.handleShortcut(event, input));
  }

  isAllowedNavigation(target) {
    try {
      const from = new URL(this.room.url);
      const to = new URL(target);
      if (to.protocol !== 'http:' && to.protocol !== 'https:') return false;
      if (to.hostname === from.hostname) return true;
      const fromRoot = from.hostname.split('.').slice(-2).join('.');
      const toRoot = to.hostname.split('.').slice(-2).join('.');
      if (fromRoot === toRoot) return true;
      return AUTH_HOSTS.some((h) => to.hostname === h || to.hostname.endsWith('.' + h));
    } catch {
      return false;
    }
  }

  layout() {
    if (!this.win || !this.view) return;
    const [w, h] = this.win.getContentSize();
    if (this.ui) this.ui.setBounds({ x: 0, y: 0, width: w, height: h });
    const bounds = this.win.isFullScreen()
      ? { x: 0, y: 0, width: w, height: h }
      : { x: 0, y: HEADER_HEIGHT, width: w, height: Math.max(0, h - HEADER_HEIGHT) };
    this.normalBounds = bounds;
    if (this.viewLowered) {
      this.view.setBounds({ x: -20000, y: -20000, width: bounds.width, height: bounds.height });
    } else {
      this.view.setBounds(bounds);
    }
  }

  lowerView() {
    if (!this.win || !this.view) return;
    this.viewLowered = true;
    if (this.normalBounds) {
      this.view.setBounds({ x: -20000, y: -20000, width: this.normalBounds.width, height: this.normalBounds.height });
    }
    this.applyAudio();
  }

  raiseView() {
    if (!this.win || !this.view) return;
    this.viewLowered = false;
    if (this.normalBounds) this.view.setBounds(this.normalBounds);
    else this.layout();
    this.applyAudio();
  }

  applyAudio() {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.view.webContents.setAudioMuted(!!this.muted || (this.viewLowered && !this.aiMode));
  }

  async runInPage(code, world = this.theaterWorld, userGesture = true) {
    if (!this.view || this.view.webContents.isDestroyed()) throw new Error('view unavailable');
    const wc = this.view.webContents;
    if (world === 'isolated') {
      return wc.executeJavaScriptInIsolatedWorld(THEATER_WORLD_ID, [{ code }], userGesture);
    }
    return wc.executeJavaScript(code, userGesture);
  }

  async readPageText() {
    try {
      return await withTimeout(
        this.runInPage(
          `(() => { const b = document.body; return b ? (b.textContent || '').replace(/\\s+/g, ' ').slice(0, 30000) : ''; })()`,
          this.theaterWorld,
          false
        ),
        1200,
        'page-text'
      );
    } catch {
      return '';
    }
  }

  open(room, options = {}) {
    this.ensureWindow();
    this.room = room;
    if (this.ui && !this.ui.webContents.isDestroyed()) this.ui.setVisible(true);
    if (this.view && !this.view.webContents.isDestroyed()) this.view.setVisible(true);
    this.clean = options.forceWeb ? false : !!this.store.getSettings().clean;
    this.enhance = !!this.store.getSettings().enhance;
    this.stopAiMode();
    debug('open', room.url, 'clean', this.clean);
    this.win.setTitle(room.name || fallbackName(room));
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('library:player-active', true);
    if (this.ui) {
      this.ui.setVisible(true);
      this.layout();
    }
    this.win.show();
    this.win.focus();
    if (this.ui && !this.ui.webContents.isDestroyed()) this.ui.webContents.focus();
    this.loadToken++;
    this.stopTimers();
    this.ready = false;
    this.loading = true;
    this.error = null;
    this.mediaType = null;
    this.lastPaused = null;
    this.captureTimer = null;
    this.theaterWorld = 'main';
    this.stallTicks = 0;
    this.qualities = [];
    this.qualityCurrent = '';
    this.qualityLabel = '';
    this.qualityNote = '';
    this.qualityBusy = false;
    this.lowerView();
    this.sendState();
    this.loadRoomUrl();
    this.lastShownRoomId = room.id;
    if (!room.virtual) this.store.updateRoom(room.id, { lastOpenedAt: Date.now() });
    this.onRoomsChanged?.();
    this.sendState();
    this.updatePoll();
  }

  loadRoomUrl() {
    if (!this.room || !this.view) return;
    this.view.webContents.loadURL(this.room.url, {
      userAgent: global.__PURELIVE_UA__,
      extraHeaders: 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8\r\n',
    }).catch((e) => {
      if (e && e.code !== -3) this.fail('无法打开这个链接');
    });
  }

  onNavigationStarted() {
    this.ready = false;
    this.loading = true;
    this.error = null;
    this.mediaType = null;
    this.lowerView();
    this.sendState();
  }

  async handleDomReady() {
    if (!this.win || !this.view || !this.room) return;
    debug('dom-ready', this.room.url);
    const token = ++this.loadToken;
    this.loading = true;
    this.ready = false;
    this.error = null;
    this.lowerView();
    this.sendState();
    if (!this.clean) {
      setTimeout(() => {
        if (token !== this.loadToken || !this.view) return;
        this.showPage();
      }, 550);
      return;
    }
    this.theaterWorld = 'main';
    if (await this.injectTheater(token)) this.waitForMedia(token, 0);
  }

  async injectTheater(token, attempt = 0) {
    if (!this.view || token !== this.loadToken) return false;
    const world = attempt === 0 ? 'main' : 'isolated';
    try {
      const r = await withTimeout(
        this.runInPage(
          buildTheaterScript(this.room.platform, {
            width: this.normalBounds?.width || 1280,
            height: this.normalBounds?.height || 720,
            enhance: this.enhance,
          }),
          world,
          true
        ),
        4500,
        'theater-inject'
      );
      this.theaterWorld = world;
      debug('theater injected', r, 'attempt', attempt, world);
      return true;
    } catch (e) {
      debug('theater inject failed', e.message, 'attempt', attempt, world);
      if (token !== this.loadToken) return false;
      if (attempt < 2) {
        await delay(1200);
        if (token !== this.loadToken) return false;
        return this.injectTheater(token, attempt + 1);
      }
      this.fail('这个页面没有响应纯净模式。你可以重试，或切换到「网页模式」查看。', { noMedia: true });
      return false;
    }
  }

  async waitForMedia(token, attempt) {
    if (!this.view || token !== this.loadToken) return;
    if (attempt > 30) {
      this.fail('没有识别到直播画面。你可以重试，或切换到「网页模式」手动播放。', { noMedia: true });
      return;
    }
    let info = null;
    try {
      info = await withTimeout(this.runInPage(`(() => {
        const t = window.__pureliveTheater;
        if (!t || !t.media) return { ok: false, inner: [innerWidth, innerHeight] };
        const m = t.media;
        return {
          ok: true,
          tag: m.tagName,
          paused: m.tagName === 'VIDEO' ? !!m.paused : null,
          readyState: m.tagName === 'VIDEO' ? m.readyState : null,
          hasSrc: m.tagName === 'VIDEO' ? (!!(m.currentSrc || m.src || m.querySelector('source')) || m.readyState > 0) : true,
          w: m.getBoundingClientRect().width,
          h: m.getBoundingClientRect().height,
        };
      })()`, this.theaterWorld, true), 1600, 'media-probe');
    } catch (e) {
      debug('media probe error', e.message);
      this.probeTimeouts = (this.probeTimeouts || 0) + 1;
      if (this.probeTimeouts >= 4) {
        this.fail('页面没有响应。请重试，或切换到「网页模式」查看。', { noMedia: true });
        return;
      }
    }
    if (info) this.probeTimeouts = 0;
    if (info && info.ok) {
      const stalledVideo = info.tag === 'VIDEO' && info.readyState === 0;
      if (stalledVideo) {
        this.stallTicks = (this.stallTicks || 0) + 1;
        if (this.stallTicks === 6) {
          const text = await this.readPageText();
          if (/主播暂未开播|主播还未开播|直播已结束|直播已经结束|直播结束|主播不在|尚未开播/.test(text)) {
            this.fail('主播当前暂未开播或直播已经结束。可以稍后再来，或切换到「网页模式」查看直播间状态。', { offline: true });
            return;
          }
          if (/登录后观看|请登录后|扫码登录|安全验证|人机验证|完成验证|captcha/i.test(text)) {
            this.fail('这个直播间需要登录或完成站点验证。切换到「网页模式」即可处理。', { needsLogin: true });
            return;
          }
        }
        if (this.stallTicks < 18) {
          setTimeout(() => this.waitForMedia(token, attempt + 1), 500);
          return;
        }
        this.fail('直播画面一直没有开始播放。可以重试，或切换到「网页模式」查看。', { noMedia: true });
        return;
      }
      this.stallTicks = 0;
      this.mediaType = info.tag === 'VIDEO' ? 'video' : 'iframe';
      if (this.mediaType === 'iframe') this.injectFrames(token);
      this.showPage();
      if (info.tag === 'VIDEO' && info.paused) {
        try {
          await this.runInPage(`(() => { const m = window.__pureliveTheater && window.__pureliveTheater.media; if (m && m.paused) m.play().catch(()=>{}); })()`, this.theaterWorld);
        } catch {}
      }
      return;
    }
    setTimeout(() => this.waitForMedia(token, attempt + 1), 500);
  }

  async injectFrames(token) {
    if (!this.view || token !== this.loadToken) return;
    setTimeout(async () => {
      if (!this.view || token !== this.loadToken) return;
      try {
        const frames = this.view.webContents.mainFrame.framesInSubtree.filter((f) => f !== this.view.webContents.mainFrame);
        for (const frame of frames) {
          try {
            await frame.executeJavaScript(buildTheaterScript(this.room.platform, { subframe: true }), true);
          } catch {}
        }
      } catch {}
    }, 1200);
  }

  showPage() {
    if (!this.win || !this.view) return;
    debug('show page', this.mediaType);
    this.loading = false;
    this.ready = true;
    this.error = null;
    if (this.aiMode) {
      this.lowerView();
      this.applyAudio();
      if (this.ui && !this.ui.webContents.isDestroyed()) this.ui.webContents.send('player:ai-start');
      clearTimeout(this.aiTimer);
      this.aiTimer = setTimeout(() => this.pumpAiFrame(), 300);
    } else {
      this.raiseView();
    }
    this.sendState();
    this.updatePoll();
    this.scheduleCapture();
    setTimeout(() => {
      if (!this.view || !this.ready) return;
      this.runInPage('window.dispatchEvent(new Event("resize"))', this.theaterWorld, false).catch(() => {});
    }, 180);
    if (this.clean) setTimeout(() => this.refreshQualities(true), 1200);
  }

  async refreshQualities(silent = true) {
    if (!this.ready || !this.view || !this.room) return;
    const platform = this.room.platform;
    let result = null;
    try {
      if (platform === 'bilibili') {
        result = await withTimeout(this.view.webContents.executeJavaScript(`(() => {
          try {
            const p = window.livePlayer;
            if (!p || typeof p.getPlayerInfo !== 'function') {
              return { ok: false, note: 'B 站播放器接口还没有就绪，请稍后刷新重试。' };
            }
            const info = p.getPlayerInfo();
            const current = String(info.quality == null ? '' : info.quality);
            const list = (info.qualityCandidates || []).map((q) => {
              const id = String(q.qn);
              return { id, label: String(q.desc || id), current: id === current, locked: false };
            });
            const cur = list.find((x) => x.current);
            return { ok: true, current, label: cur ? cur.label : current, qualities: list, note: '高画质可能需要登录 B 站；切换失败时会给出提示。' };
          } catch (e) {
            return { ok: false, note: '读取清晰度失败：' + e.message };
          }
        })()`, true), 2500, 'read-quality');
      } else if (platform === 'huya') {
        result = await withTimeout(this.view.webContents.executeJavaScript(`(() => {
          try {
            const list = [...document.querySelectorAll('.player-videotype-list li')];
            const cur = document.querySelector('.player-videotype-cur');
            if (!list.length) return { ok: false, note: '清晰度菜单还没有加载，请刷新后重试。' };
            const current = (cur ? cur.textContent : '').trim();
            return {
              ok: true,
              current,
              label: current,
              qualities: list.map((li, i) => {
                const label = ((li.querySelector('span') || {}).textContent || '').trim();
                return { id: String(i), label, current: li.classList.contains('on') || label === current, locked: !!li.querySelector('.common-enjoy-btn') };
              }),
              note: '标注「登录」的画质需要登录虎牙。',
            };
          } catch (e) {
            return { ok: false, note: '读取清晰度失败：' + e.message };
          }
        })()`, true), 2500, 'read-quality');
      } else if (platform === 'douyu') {
        result = {
          ok: true,
          current: '自动',
          label: '自动',
          qualities: [],
          note: '斗鱼当前由播放器自动选择清晰度。需要手动切换时，请使用网页模式。',
        };
      }
    } catch (e) {
      debug('quality read failed', e.message);
    }
    if (!this.room || this.view.webContents.isDestroyed()) return;
    if (!result) {
      result = { ok: false, note: '此站点暂不支持在纯净模式中切换清晰度，可切换到网页模式调整。' };
    }
    this.qualities = Array.isArray(result.qualities) ? result.qualities.filter((q) => q && q.label) : [];
    this.qualityCurrent = result.current || '';
    this.qualityLabel = result.label || '';
    this.qualityNote = result.note || '';
    this.qualityBusy = false;
    this.sendState();
    if (!silent) this.toast(this.qualityNote || '清晰度信息已刷新');
  }

  async setQuality(id) {
    if (!this.ready || !this.view || this.qualityBusy) return;
    const platform = this.room.platform;
    if (platform !== 'bilibili' && platform !== 'huya') {
      this.toast('请在网页模式中调整清晰度');
      return;
    }
    this.qualityBusy = true;
    this.sendState();
    try {
      if (platform === 'bilibili') {
        const r = await withTimeout(this.view.webContents.executeJavaScript(`(async () => {
          try {
            const p = window.livePlayer;
            if (!p || typeof p.switchQualityAsync !== 'function') return { ok: false, msg: '播放器接口不可用' };
            const result = await p.switchQualityAsync(${JSON.stringify(String(id))});
            return { ok: !!(result && result.code === 0), code: result && result.code, msg: (result && result.msg) || '' };
          } catch (e) {
            return { ok: false, msg: e.message };
          }
        })()`, true), 9000, 'switch-quality');
        if (!r || !r.ok) {
          const msg = /login|登录/i.test(r?.msg || '') || r?.code === 1000004
            ? '这个清晰度需要登录 B 站。请先切到网页模式登录，再回来切换。'
            : '清晰度切换失败' + (r?.msg ? '：' + r.msg : '');
          this.qualityBusy = false;
          this.sendState();
          this.toast(msg);
          return;
        }
        await delay(1800);
        await this.refreshQualities(true);
        this.toast('清晰度已切换');
      } else {
        const before = this.qualityCurrent;
        const r = await withTimeout(this.view.webContents.executeJavaScript(`(() => {
          const list = [...document.querySelectorAll('.player-videotype-list li')];
          const li = list[${Number(id)}];
          if (!li) return { ok: false };
          li.click();
          return { ok: true };
        })()`, true), 2500, 'switch-quality');
        if (!r || !r.ok) {
          this.qualityBusy = false;
          this.sendState();
          this.toast('没有找到这个清晰度选项，请刷新后重试');
          return;
        }
        await delay(2200);
        await this.refreshQualities(true);
        try {
          await this.view.webContents.executeJavaScript('window.__pureliveTheater && window.__pureliveTheater.refresh && window.__pureliveTheater.refresh()', true);
        } catch {}
        if (before && this.qualityCurrent && before === this.qualityCurrent) {
          this.toast('切换请求已发送，若未生效可能需要登录该清晰度');
        } else {
          this.toast('清晰度已切换');
        }
      }
    } catch (e) {
      debug('quality switch failed', e.message);
      this.qualityBusy = false;
      this.sendState();
      this.toast('清晰度切换超时，请重试或使用网页模式');
    }
  }

  scheduleCapture(attempt = 0) {
    clearTimeout(this.captureTimer);
    this.captureTimer = setTimeout(async () => {
      if (!this.view || !this.ready || !this.room || this.room.virtual) return;
      try {
        const image = await this.view.webContents.capturePage();
        const bitmap = image.toBitmap();
        let total = 0;
        let count = 0;
        for (let i = 0; i < bitmap.length; i += 4 * 97) {
          total += bitmap[i] + bitmap[i + 1] + bitmap[i + 2];
          count += 3;
        }
        const average = count ? total / count : 0;
        if (average < 5 && attempt < 3) {
          this.scheduleCapture(attempt + 1);
          return;
        }
        if (this.thumbnails.save(this.room.id, image)) {
          this.onRoomsChanged?.();
          this.sendState();
        }
      } catch {}
    }, attempt === 0 ? 5000 : 3500);
  }

  fail(message, extra = {}) {
    debug('fail', message, extra);
    if (this.aiMode) this.stopAiMode();
    this.loading = false;
    this.ready = false;
    this.error = { message, ...extra };
    this.lowerView();
    this.sendState();
  }

  toggleClean() {
    return this.setClean(!this.clean);
  }

  setClean(value) {
    if (!this.room) return;
    if (this.room.virtual) {
      this.toast('账号登录页固定在网页模式');
      return;
    }
    this.clean = !!value;
    this.sendState();
    this.reload();
  }

  reload() {
    if (!this.room) return;
    this.onNavigationStarted();
    this.view.webContents.reload();
  }

  async togglePlay() {
    if (!this.view) return;
    if (this.room && this.room.virtual) {
      this.toast('账号登录页不需要暂停画面');
      return;
    }
    try {
      const res = await this.runInPage(`(() => {
        const t = window.__pureliveTheater;
        const m = t && t.media;
        if (!m || m.tagName !== 'VIDEO') return { ok: false };
        const paused = !(typeof t.getPaused === 'function' ? t.getPaused() : m.paused);
        if (typeof t.setPaused === 'function') t.setPaused(paused);
        else if (paused) m.pause();
        else m.play().catch(() => {});
        return { ok: true, paused };
      })()`, this.theaterWorld, true);
      if (!res?.ok) this.toast('这个直播间使用内嵌播放器，请直接在画面中操作');
      else {
        this.lastPaused = res.paused;
        this.sendState();
      }
    } catch {}
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyAudio();
    this.sendState();
  }

  togglePin() {
    this.pinned = !this.pinned;
    if (this.win) this.win.setAlwaysOnTop(this.pinned);
    this.sendState();
  }

  toggleFullscreen() {
    if (!this.win) return;
    this.win.setFullScreen(!this.win.isFullScreen());
    setTimeout(() => this.layout(), 60);
  }

  handleShortcut(event, input) {
    if (!input || input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      event.preventDefault();
      this.toggleFullscreen();
      return;
    }
    if (input.key === 'Escape' && this.win?.isFullScreen()) {
      event.preventDefault();
      this.win.setFullScreen(false);
      setTimeout(() => this.layout(), 60);
      return;
    }
    if (input.key === ' ' && this.clean) {
      event.preventDefault();
      this.togglePlay();
      return;
    }
    if ((input.key === 'm' || input.key === 'M') && !input.control && !input.alt) {
      event.preventDefault();
      this.toggleMute();
    }
  }

  handlePageTitle(title) {
    if (!this.room) return;
    if (this.store.setAutoName(this.room.id, title)) {
      this.room = this.store.getRoom(this.room.id) || this.room;
      if (this.win) this.win.setTitle(this.room.name);
      this.onRoomsChanged?.();
      this.sendState();
    }
  }

  updatePoll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (!this.view || !this.ready || this.mediaType !== 'video') return;
      try {
        const paused = await this.runInPage(
          `(() => { const t = window.__pureliveTheater; if (!t || !t.media || t.media.tagName !== 'VIDEO') return null; return typeof t.getPaused === 'function' ? !!t.getPaused() : !!t.media.paused; })()`,
          this.theaterWorld,
          false
        );
        if (paused !== null && paused !== this.lastPaused) {
          this.lastPaused = paused;
          this.sendState();
        }
      } catch {}
    }, 1500);
  }

  stopTimers() {
    clearTimeout(this.captureTimer);
    clearInterval(this.pollTimer);
    clearTimeout(this.aiTimer);
    this.captureTimer = null;
    this.pollTimer = null;
    this.aiTimer = null;
  }

  getState() {
    const room = this.room ? (this.store.getRoom(this.room.id) || this.room) : null;
    const platform = room ? publicPlatform(platformOf(room)) : null;
    return {
      room: room ? { ...room, displayName: room.name || fallbackName(room) } : null,
      platform,
      clean: this.clean,
      muted: this.muted,
      pinned: this.pinned,
      fullscreen: !!(this.win && this.win.isFullScreen()),
      loading: this.loading,
      ready: this.ready,
      error: this.error,
      mediaType: this.mediaType,
      paused: this.lastPaused,
      qualities: this.qualities,
      qualityCurrent: this.qualityCurrent,
      qualityLabel: this.qualityLabel,
      qualityNote: this.qualityNote,
      qualityBusy: this.qualityBusy,
      enhance: !!this.enhance,
      aiMode: !!this.aiMode,
      aiFps: this.aiFps,
      aiBusy: !!this.aiBusy,
      loginMode: !!this.room?.virtual,
    };
  }

  sendState() {
    if (this.ui && !this.ui.webContents.isDestroyed()) {
      this.ui.webContents.send('player:state', this.getState());
    }
  }

  toast(message) {
    if (this.ui && !this.ui.webContents.isDestroyed()) this.ui.webContents.send('player:toast', message);
  }

  async setEnhance(on) {
    if (!this.ready || !this.view) {
      this.toast('画面接通后即可开启画质增强');
      return;
    }
    this.enhance = !!on;
    let applied = null;
    try {
      applied = await this.runInPage(
        `(() => { const t = window.__pureliveTheater; return t && typeof t.setEnhance === 'function' ? t.setEnhance(${this.enhance ? 'true' : 'false'}) : null; })()`,
        this.theaterWorld,
        true
      );
    } catch (e) {
      debug('enhance toggle failed', e.message);
    }
    if (this.enhance && applied === false) {
      this.enhance = false;
      this.store.setSettings({ enhance: false });
      this.sendState();
      this.toast('当前设备或画面无法开启实时增强');
      return;
    }
    this.store.setSettings({ enhance: this.enhance });
    this.sendState();
    this.toast(this.enhance ? '已开启实时画质增强（GPU）' : '已关闭实时画质增强');
  }

  stopAiMode() {
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
    const wasAi = this.aiMode;
    this.aiMode = false;
    this.aiBusy = false;
    this.aiFrames = 0;
    this.aiFps = 0;
    this.aiFpsStart = 0;
    if (this.win && !this.win.isDestroyed()) {
      if (this.ui && !this.ui.webContents.isDestroyed()) this.ui.webContents.send('player:ai-stop');
      if (wasAi && this.ready) {
        this.raiseView();
        if (this.enhance) {
          this.runInPage(
            `(() => { const t = window.__pureliveTheater; if (t && typeof t.setEnhance === 'function') t.setEnhance(true); })()`,
            this.theaterWorld,
            false
          ).catch(() => {});
        }
      }
    }
    this.applyAudio();
    this.sendState();
  }

  async setAiMode(on) {
    if (!on) {
      this.stopAiMode();
      this.toast('已关闭 AI 超分');
      return;
    }
    if (!this.ready || !this.view || this.error) {
      this.toast('画面接通后才能开启 AI 超分');
      return;
    }
    if (this.aiMode) return;
    this.aiMode = true;
    this.aiBusy = false;
    this.aiFrames = 0;
    this.aiFps = 0;
    this.aiFpsStart = 0;
    try {
      await this.runInPage(
        `(() => { const t = window.__pureliveTheater; if (t && typeof t.setEnhance === 'function') t.setEnhance(false); })()`,
        this.theaterWorld,
        false
      );
    } catch {}
    this.lowerView();
    this.applyAudio();
    this.sendState();
    if (this.win && !this.win.isDestroyed()) {
      this.ui.webContents.send('player:ai-start');
    }
    this.toast('AI 超分实验模式已开启：本地模型，约 5fps，CPU 占用会升高');
    clearTimeout(this.aiTimer);
    this.aiTimer = setTimeout(() => this.pumpAiFrame(), 300);
  }

  async pumpAiFrame() {
    if (!this.aiMode || this.aiBusy || !this.ready || !this.view) return;
    if (!this.win || this.win.isDestroyed()) return;
    this.aiBusy = true;
    const token = this.loadToken;
    try {
      const frame = await withTimeout(this.captureAiFrame(), 3500, 'ai-frame');
      if (!this.aiMode || token !== this.loadToken) {
        this.aiBusy = false;
        return;
      }
      if (!frame || !frame.data) {
        this.aiBusy = false;
        this.aiTimer = setTimeout(() => this.pumpAiFrame(), 500);
        return;
      }
      this.ui.webContents.send('player:ai-frame', frame);
      clearTimeout(this.aiTimer);
      this.aiTimer = setTimeout(() => {
        if (this.aiMode && this.aiBusy) {
          this.aiBusy = false;
          this.pumpAiFrame();
        }
      }, 8000);
    } catch (e) {
      debug('ai frame failed', e.message);
      this.aiBusy = false;
      this.aiTimer = setTimeout(() => this.pumpAiFrame(), 700);
    }
  }

  async captureAiFrame() {
    if (!this.view) return null;
    return this.runInPage(`(() => {
      try {
        const t = window.__pureliveTheater;
        const v = t && t.media;
        if (!v || v.tagName !== 'VIDEO' || v.readyState < 2 || !v.videoWidth) return null;
        let c = t.__aiCaptureCanvas;
        if (!c) {
          c = document.createElement('canvas');
          c.width = 224; c.height = 224;
          t.__aiCaptureCanvas = c;
        }
        const ctx = c.getContext('2d', { alpha: false });
        const vw = v.videoWidth, vh = v.videoHeight;
        const scale = Math.min(224 / vw, 224 / vh);
        const dw = vw * scale, dh = vh * scale;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 224, 224);
        ctx.drawImage(v, (224 - dw) / 2, (224 - dh) / 2, dw, dh);
        const data = c.toDataURL('image/jpeg', 0.8).split(',')[1];
        return { data, aspect: vw / Math.max(1, vh) };
      } catch (e) { return null; }
    })()`, this.theaterWorld, false);
  }

  aiFrameDone() {
    if (!this.aiMode) return;
    this.aiBusy = false;
    this.aiFrames++;
    if (!this.aiFpsStart) this.aiFpsStart = Date.now();
    const elapsed = Date.now() - this.aiFpsStart;
    if (elapsed >= 1000) {
      this.aiFps = Math.round((this.aiFrames * 1000) / elapsed);
      this.aiFrames = 0;
      this.aiFpsStart = Date.now();
      this.sendState();
    }
    clearTimeout(this.aiTimer);
    this.aiTimer = setTimeout(() => this.pumpAiFrame(), 20);
  }

  aiFailed(message) {
    if (!this.aiMode) return;
    this.stopAiMode();
    this.toast('AI 超分失败：' + (message || '模型运行异常'));
  }

  async showQualityMenu(position = {}) {
    if (!this.win || this.win.isDestroyed() || !this.room) return;
    if (this.room.virtual) {
      this.toast('账号登录页不需要调整清晰度');
      return;
    }
    if (!this.ready) {
      this.toast('画面接通后即可调整清晰度');
      return;
    }
    if (!this.qualities.length) await this.refreshQualities(true);
    if (!this.win || this.win.isDestroyed()) return;
    const platform = platformOf(this.room).name;
    const template = [
      { label: `清晰度 · ${platform}`, enabled: false },
    ];
    if (this.qualities.length) {
      for (const q of this.qualities) {
        template.push({
          label: q.locked ? `${q.label}（需登录）` : q.label,
          type: 'radio',
          checked: !!q.current,
          enabled: !q.locked && !this.qualityBusy,
          click: () => this.setQuality(q.id),
        });
      }
    } else {
      template.push({
        label: this.qualityBusy ? '正在读取清晰度…' : (this.qualityNote || '清晰度信息读取失败，请稍后重试'),
        enabled: false,
      });
    }
    template.push({ type: 'separator' });
    template.push({
      label: '实时画质增强（GPU）',
      type: 'checkbox',
      checked: !!this.enhance,
      click: () => this.setEnhance(!this.enhance),
    });
    template.push({ label: '刷新清晰度列表', click: () => this.refreshQualities(false) });
    template.push({ label: '在网页模式中调整', click: () => this.setClean(false) });
    const menu = Menu.buildFromTemplate(template);
    const popup = {};
    if (Number.isFinite(position.x) && Number.isFinite(position.y)) {
      popup.x = Math.max(4, Math.round(position.x));
      popup.y = Math.max(HEADER_HEIGHT, Math.round(position.y));
    }
    menu.popup({ window: this.win, ...popup });
  }

  showMoreMenu(position = {}) {
    if (!this.win || this.win.isDestroyed()) return;
    const menu = Menu.buildFromTemplate([
      { label: this.lastPaused ? '继续播放' : '暂停画面', click: () => this.togglePlay() },
      { label: '刷新画面', click: () => this.reload() },
      { label: this.win.isFullScreen() ? '退出全屏' : '进入全屏', click: () => this.toggleFullscreen() },
      { type: 'separator' },
      { label: '复制直播间链接', click: () => this.copyUrl() },
      { label: '在浏览器打开', click: () => this.openExternal() },
      { label: '回到直播间首页', click: () => this.reload() },
      { type: 'separator' },
      { label: '返回直播架', click: () => this.close() },    ]);
    const popup = {};
    if (Number.isFinite(position.x) && Number.isFinite(position.y)) {
      popup.x = Math.max(4, Math.round(position.x));
      popup.y = Math.max(HEADER_HEIGHT, Math.round(position.y));
    }
    menu.popup({ window: this.win, ...popup });
  }

  copyUrl() {
    if (this.room) clipboard.writeText(this.room.url);
    this.toast('直播间链接已复制');
  }

  openExternal() {
    if (this.room) shell.openExternal(this.room.url).catch(() => {});
  }

  openLogin(platformId) {
    const platform = PLATFORM_MAP.get(platformId);
    if (!platform || !platform.loginUrl) return false;
    const room = {
      id: 'login-' + platform.id,
      url: platform.loginUrl,
      name: '账号登录 · ' + platform.name,
      platform: platform.id,
      virtual: true,
      favorite: false,
    };
    this.open(room, { forceWeb: true });
    return true;
  }

  close() {
    this.stopAiMode();
    this.stopTimers();
    this.ready = false;
    this.loading = false;
    this.error = null;
    this.mediaType = null;
    this.room = null;
    if (this.view && !this.view.webContents.isDestroyed()) {
      try { this.view.setVisible(false); } catch {}
    }
    if (this.ui && !this.ui.webContents.isDestroyed()) {
      try { this.ui.setVisible(false); } catch {}
    }
    this.pinned = false;
    if (this.win && !this.win.isDestroyed()) {
      this.win.setAlwaysOnTop(false);
      this.win.setTitle('净播 PureLive');
      this.win.webContents.send('library:player-active', false);
      if (this.win.isFullScreen()) this.win.setFullScreen(false);
      this.win.show();
      this.win.focus();
    }
    this.onRoomsChanged?.();
    this.onBack?.();
  }

  focus() {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
    }
  }

  openDevTools() {
    if (this.view) this.view.webContents.openDevTools({ mode: 'detach' });
  }
}

module.exports = { PlayerWindow, HEADER_HEIGHT };
