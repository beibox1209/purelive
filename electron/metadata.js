'use strict';

const { net } = require('electron');
const { cleanTitle } = require('./store');

function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    middot: '·', mdash: '—', ndash: '–', hellip: '…',
  };
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] || m);
}

function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1]).trim();
  }
  return '';
}

async function fetchPageMeta(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) return {};
    const contentType = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(contentType)) return {};
    const html = await res.text();
    const head = html.slice(0, 600000);
    const title = firstMatch(head, [
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i,
      /<title[^>]*>([\s\S]*?)<\/title>/i,
    ]);
    let image = firstMatch(head, [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ]);
    if (image) {
      try { image = new URL(image, url).href; } catch {}
    }
    return { title: cleanTitle(title), image };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPageTitle(url) {
  const meta = await fetchPageMeta(url);
  return meta.title || '';
}

async function fetchJson(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'accept': 'application/json,text/plain,*/*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'referer': referer || url,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImageBuffer(url, referer) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'accept': 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
        'referer': referer || url,
      },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) return null;
    const length = Number(res.headers.get('content-length') || 0);
    if (length > 12 * 1024 * 1024) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > 12 * 1024 * 1024) return null;
    return buffer;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function numericRoomId(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    for (const part of parts) {
      if (/^\d{4,}$/.test(part)) return part;
    }
  } catch {}
  return '';
}

async function fetchLiveCover(room) {
  const platform = room.platform;
  const url = room.url;
  try {
    if (platform === 'bilibili') {
      const id = numericRoomId(url);
      if (!id) return '';
      const data = await fetchJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${id}`, 'https://live.bilibili.com/');
      const roomData = data?.data || {};
      return roomData.keyframe || roomData.user_cover || roomData.cover || '';
    }
    if (platform === 'huya') {
      const id = numericRoomId(url);
      if (id) {
        const data = await fetchJson(`https://www.huya.com/cache.php?m=Live&do=profileRoom&roomid=${id}`, 'https://www.huya.com/');
        const d = data?.data || {};
        const image = d.screenshot || d.room_pic || d.avatar || '';
        if (image) return image;
      }
      const meta = await fetchPageMeta(url);
      return meta.image || '';
    }
    if (platform === 'douyu') {
      const id = numericRoomId(url);
      if (id) {
        const data = await fetchJson(`https://www.douyu.com/betard/${id}`, 'https://www.douyu.com/');
        const r = data?.room || data?.data || {};
        const image = r.room_pic || r.room_src || r.avatar || r.room_pic_url || '';
        if (image) return image;
      }
      const meta = await fetchPageMeta(url);
      return meta.image || '';
    }
    if (platform === 'youtube') {
      try {
        const u = new URL(url);
        const id = u.searchParams.get('v') || (u.hostname.includes('youtu.be') ? u.pathname.slice(1) : '');
        if (id) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      } catch {}
    }
    const meta = await fetchPageMeta(url);
    return meta.image || '';
  } catch {
    return '';
  }
}

module.exports = { fetchPageMeta, fetchPageTitle, fetchLiveCover, fetchImageBuffer };
