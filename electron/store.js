'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detectPlatform } = require('./platforms');

const DATA_VERSION = 1;
const TRACKING_PARAMS = new Set([
  'spm_id_from',
  'from',
  'from_source',
  'share_source',
  'share_medium',
  'share_plat',
  'share_session_id',
  'share_timestamp',
  'share_tag',
  'timestamp',
  'vd_source',
  'unique_k',
  'broadcast_type',
  'is_room_feed',
  'live_from',
  'enter_from',
  'launch_id',
]);

function normalizeUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('请输入直播间链接');
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) {
    throw new Error('仅支持 http 或 https 链接');
  }
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('链接格式不正确');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('仅支持 http 或 https 链接');
  if (!url.hostname || !url.hostname.includes('.')) throw new Error('链接格式不正确');
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }
  if (url.pathname === '/' && !url.search) return url.origin;
  return url.toString().replace(/\/$/, '');
}

function cleanTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const suffixes = [
    /[-_|]\s*哔哩哔哩直播.*$/u,
    /[-_|]\s*哔哩哔哩.*$/u,
    /[-_|]\s*斗鱼直播.*$/u,
    /[-_|]\s*斗鱼.*$/u,
    /[-_|]\s*虎牙直播.*$/u,
    /[-_|]\s*虎牙.*$/u,
    /\s*[-_|]\s*YouTube$/iu,
    /\s*[-_|]\s*Twitch$/iu,
    /\s*[-_|]\s*抖音直播.*$/u,
    /\s*[-_|]\s*抖音.*$/u,
    /\s*[-_|]\s*Kick$/iu,
    /\s*[-_|]\s*快手直播.*$/u,
  ];
  for (const re of suffixes) t = t.replace(re, '');
  return t.trim().slice(0, 80);
}

class Store {
  constructor(userDataPath) {
    this.path = path.join(userDataPath, 'purelive-data.json');
    this.data = {
      version: DATA_VERSION,
      rooms: [],
      settings: { clean: true, mute: false, alwaysOnTop: false },
      libraryWindow: null,
      playerWindow: null,
    };
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.rooms)) {
        this.data = {
          ...this.data,
          ...parsed,
          settings: { ...this.data.settings, ...(parsed.settings || {}) },
          rooms: parsed.rooms
            .filter((r) => r && typeof r.url === 'string')
            .map((r) => ({
              id: r.id || crypto.randomUUID(),
              url: r.url,
              name: typeof r.name === 'string' ? r.name : '',
              nameLocked: !!r.nameLocked,
              platform: r.platform || detectPlatform(r.url).id,
              createdAt: Number(r.createdAt) || Date.now(),
              lastOpenedAt: Number(r.lastOpenedAt) || 0,
              favorite: !!r.favorite,
            })),
        };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        try {
          fs.copyFileSync(this.path, this.path + '.broken-' + Date.now());
        } catch {}
      }
    }
  }

  saveNow() {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.path);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try { this.saveNow(); } catch (e) { console.error('[PureLive] save failed', e); }
    }, 120);
  }

  getRooms() {
    return this.data.rooms;
  }

  getRoom(id) {
    return this.data.rooms.find((r) => r.id === id) || null;
  }

  getSettings() {
    return this.data.settings;
  }

  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }

  addRoom({ url, name }) {
    const normalized = normalizeUrl(url);
    const duplicate = this.data.rooms.find((r) => r.url === normalized);
    if (duplicate) {
      const err = new Error('这个直播间已经在列表里了');
      err.code = 'DUPLICATE';
      err.room = duplicate;
      throw err;
    }
    const platform = detectPlatform(normalized);
    const customName = cleanTitle(name);
    const room = {
      id: crypto.randomUUID(),
      url: normalized,
      name: customName,
      nameLocked: !!customName,
      platform: platform.id,
      createdAt: Date.now(),
      lastOpenedAt: 0,
      favorite: false,
    };
    this.data.rooms.unshift(room);
    this.save();
    return room;
  }

  updateRoom(id, patch) {
    const room = this.getRoom(id);
    if (!room) throw new Error('直播间不存在');
    if (patch.url !== undefined) {
      const normalized = normalizeUrl(patch.url);
      const duplicate = this.data.rooms.find((r) => r.id !== id && r.url === normalized);
      if (duplicate) {
        const err = new Error('这个直播间已经在列表里了');
        err.code = 'DUPLICATE';
        throw err;
      }
      room.url = normalized;
      room.platform = detectPlatform(normalized).id;
    }
    if (patch.name !== undefined) {
      const name = cleanTitle(patch.name);
      room.name = name;
      room.nameLocked = !!name;
    }
    if (patch.favorite !== undefined) room.favorite = !!patch.favorite;
    if (patch.lastOpenedAt !== undefined) room.lastOpenedAt = Number(patch.lastOpenedAt) || 0;
    this.save();
    return room;
  }

  setAutoName(id, title) {
    const room = this.getRoom(id);
    if (!room || room.nameLocked) return false;
    const name = cleanTitle(title);
    if (!name || room.name === name) return false;
    room.name = name;
    this.save();
    return true;
  }

  removeRoom(id) {
    const i = this.data.rooms.findIndex((r) => r.id === id);
    if (i === -1) return false;
    this.data.rooms.splice(i, 1);
    this.save();
    return true;
  }

  sortRooms(rooms) {
    return [...rooms].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return (b.lastOpenedAt || b.createdAt) - (a.lastOpenedAt || a.createdAt);
    });
  }

  setWindowState(key, bounds) {
    if (!bounds) return;
    this.data[key] = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      maximized: !!bounds.maximized,
    };
    this.save();
  }

  getWindowState(key) {
    return this.data[key] || null;
  }
}

module.exports = { Store, normalizeUrl, cleanTitle };
