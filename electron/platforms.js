'use strict';

const PLATFORMS = [
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    short: 'B',
    hosts: ['bilibili.com', 'b23.tv'],
    loginUrl: 'https://passport.bilibili.com/login',
    cookieNames: ['SESSDATA', 'DedeUserID'],
    color: '#00aeec',
    color2: '#ff7aa2',
  },
  {
    id: 'douyu',
    name: '斗鱼',
    short: '鱼',
    hosts: ['douyu.com', 'douyucdn.cn'],
    loginUrl: 'https://passport.douyu.com/member/login',
    cookieNames: ['acf_uid', 'acf_auth', 'dy_auth', 'acf_username'],
    color: '#ff7d00',
    color2: '#ffb347',
  },
  {
    id: 'huya',
    name: '虎牙',
    short: '虎',
    hosts: ['huya.com', 'msstatic.com'],
    loginUrl: 'https://i.huya.com/',
    cookieNames: ['udb_uid', 'huya_uid', 'udb_username', 'udb_nick'],
    color: '#ffb300',
    color2: '#ff6a00',
  },
  {
    id: 'douyin',
    name: '抖音',
    short: '抖',
    hosts: ['douyin.com', 'iesdouyin.com'],
    loginUrl: 'https://www.douyin.com/login',
    cookieNames: ['sessionid', 'sessionid_ss', 'sid_guard'],
    color: '#25f4ee',
    color2: '#fe2c55',
  },
  {
    id: 'twitch',
    name: 'Twitch',
    short: 'T',
    hosts: ['twitch.tv', 'ttvnw.net'],
    loginUrl: 'https://www.twitch.tv/login',
    cookieNames: ['auth-token'],
    color: '#9146ff',
    color2: '#c49bff',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    short: 'YT',
    hosts: ['youtube.com', 'youtu.be', 'googlevideo.com'],
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube',
    cookieNames: ['SID', 'SAPISID', 'SSID'],
    color: '#ff0033',
    color2: '#ff6b6b',
  },
  {
    id: 'kick',
    name: 'Kick',
    short: 'K',
    hosts: ['kick.com'],
    color: '#53fc18',
    color2: '#a6ff7a',
  },
  {
    id: 'kuaishou',
    name: '快手',
    short: '快',
    hosts: ['kuaishou.com', 'gifshow.com'],
    color: '#ff5000',
    color2: '#ff8a00',
  },
  {
    id: 'cc',
    name: '网易 CC',
    short: 'CC',
    hosts: ['cc.163.com'],
    color: '#e60026',
    color2: '#ff5c7a',
  },
  {
    id: 'soop',
    name: 'SOOP',
    short: 'S',
    hosts: ['sooplive.co.kr', 'afreecatv.com'],
    color: '#0b7bff',
    color2: '#43c6ff',
  },
  {
    id: 'generic',
    name: '网页直播',
    short: '网',
    hosts: [],
    color: '#8dffcf',
    color2: '#5bb8ff',
  },
];

const PLATFORM_MAP = new Map(PLATFORMS.map((p) => [p.id, p]));

function hostMatches(hostname, host) {
  const h = (hostname || '').toLowerCase();
  return h === host || h.endsWith('.' + host);
}

function detectPlatform(input) {
  const raw = String(input || '').trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch {
    return PLATFORM_MAP.get('generic');
  }
  const host = url.hostname;
  for (const p of PLATFORMS) {
    if (p.hosts.some((h) => hostMatches(host, h))) return p;
  }
  return PLATFORM_MAP.get('generic');
}

function publicPlatform(p) {
  return {
    id: p.id,
    name: p.name,
    short: p.short,
    color: p.color,
    color2: p.color2,
    hosts: p.hosts,
  };
}

module.exports = { PLATFORMS, PLATFORM_MAP, detectPlatform, publicPlatform };
