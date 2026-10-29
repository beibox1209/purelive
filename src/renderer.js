'use strict';

const api = window.purelive;

const icons = {
  play: '<svg viewBox="0 0 20 20" fill="none"><path d="M7.4 5.4c0-.8.9-1.3 1.6-.9l6.1 3.7c.7.4.7 1.4 0 1.8l-6.1 3.7c-.7.4-1.6-.1-1.6-.9V5.4Z" fill="currentColor"/></svg>',
  star: '<svg viewBox="0 0 20 20" fill="none"><path d="m10 2.9 2.2 4.4 4.9.7-3.5 3.4.8 4.9-4.4-2.3-4.4 2.3.8-4.9L2.9 8l4.9-.7L10 2.9Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="5" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="15" cy="10" r="1.3"/></svg>',
  clean: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 2.7 16 5v4.3c0 3.7-2.4 6.5-6 8-3.6-1.5-6-4.3-6-8V5l6-2.3Z" stroke="currentColor" stroke-width="1.3"/><path d="m7.3 9.8 1.8 1.8 3.6-3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  external: '<svg viewBox="0 0 20 20" fill="none"><path d="M11.2 4.2h4.6v4.6M15.8 4.2l-6.6 6.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/><path d="M8.4 4.9H5.5c-.8 0-1.3.5-1.3 1.3v8.3c0 .8.5 1.3 1.3 1.3h8.3c.8 0 1.3-.5 1.3-1.3v-2.9" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>',
  copy: '<svg viewBox="0 0 20 20" fill="none"><rect x="6.3" y="5.4" width="8.1" height="10.6" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M8.1 5.4V4.2c0-.6.4-1 1-1h1.8c.6 0 1 .4 1 1v1.2" stroke="currentColor" stroke-width="1.3"/></svg>',
  edit: '<svg viewBox="0 0 20 20" fill="none"><path d="m12.9 4.2 2.9 2.9M4.2 15.8l1-3.6 7.2-7.2c.4-.4 1.1-.4 1.5 0l1.1 1.1c.4.4.4 1.1 0 1.5l-7.2 7.2-3.6 1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  trash: '<svg viewBox="0 0 20 20" fill="none"><path d="M4.2 6.2h11.6M8 6.2V4.5c0-.6.4-1 1-1h2c.6 0 1 .4 1 1v1.7M6 6.2l.7 9.7c0 .6.5 1 1 1h4.6c.5 0 1-.4 1-1l.7-9.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 20 20" fill="none"><path d="m4.8 10.2 3.2 3.1 7.2-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const views = {
  all: { title: '全部直播间', subtitle: '把喜欢的直播，留在一块干净的屏幕上。' },
  recent: { title: '最近观看', subtitle: '从上次离开的地方，继续看下去。' },
  favorites: { title: '我的收藏', subtitle: '常看的直播间，放在最顺手的位置。' },
};

const state = {
  rooms: [],
  settings: { clean: true },
  platforms: [],
  version: '1.5.0',
};

let currentView = 'all';
let query = '';
let activeModal = null;
let editingId = null;
let deleteTargetId = null;
let menuRoomId = null;
let toastTimer = null;
let searchTimer = null;
let noResultsAction = 'clear';
let dragDepth = 0;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

function platformById(id) {
  return state.platforms.find((p) => p.id === id) || state.platforms.find((p) => p.id === 'generic') || {
    id: 'generic', name: '网页直播', short: '网', color: '#8dffcf', color2: '#5bb8ff', hosts: [],
  };
}

function safeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
}

function detectPlatform(raw) {
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  return state.platforms.find((p) => (p.hosts || []).some((h) => host === h || host.endsWith('.' + h))) || null;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function countFor(view) {
  if (view === 'recent') return state.rooms.filter((r) => r.lastOpenedAt > 0).length;
  if (view === 'favorites') return state.rooms.filter((r) => r.favorite).length;
  return state.rooms.length;
}

function filteredRooms() {
  let rooms = state.rooms;
  if (currentView === 'recent') rooms = rooms.filter((r) => r.lastOpenedAt > 0);
  if (currentView === 'favorites') rooms = rooms.filter((r) => r.favorite);
  const q = query.trim().toLowerCase();
  if (q) {
    rooms = rooms.filter((r) => {
      const p = r.platformInfo || platformById(r.platform);
      return (r.displayName || '').toLowerCase().includes(q)
        || (r.url || '').toLowerCase().includes(q)
        || (p.name || '').toLowerCase().includes(q);
    });
  }
  return rooms;
}

function updateSidebar() {
  $('#countAll').textContent = String(countFor('all'));
  $('#countRecent').textContent = String(countFor('recent'));
  $('#countFav').textContent = String(countFor('favorites'));
  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === currentView);
  });
  const meta = views[currentView];
  $('#pageTitle').textContent = meta.title;
  $('#pageSubtitle').textContent = meta.subtitle;
}

function updateStats(rooms) {
  $('#listCount').textContent = rooms.length ? `${rooms.length} 个直播间` : '等待第一个直播间';
}

function renderPlatformChips() {
  const wrap = $('#platformChips');
  if (wrap.childElementCount) return;
  const featured = ['bilibili', 'douyu', 'huya', 'douyin', 'twitch', 'youtube'];
  for (const id of featured) {
    const p = platformById(id);
    const chip = el('span', 'platform-chip', p.name);
    wrap.appendChild(chip);
  }
}

function makeCard(room, index) {
  const platform = room.platformInfo || platformById(room.platform);
  const c1 = safeColor(platform.color, '#82f3c5');
  const c2 = safeColor(platform.color2, '#6aa8ff');

  const card = el('article', 'room-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `观看 ${room.displayName}`);
  card.style.setProperty('--i', String(Math.min(index, 10)));
  card.dataset.id = room.id;

  const cover = el('div', 'room-cover');
  const fallback = el('div', 'cover-fallback');
  fallback.style.setProperty('--c1', c1);
  fallback.style.setProperty('--c2', c2);
  const mono = el('span', 'cover-monogram', platform.short || '网');
  fallback.appendChild(mono);
  cover.appendChild(fallback);

  if (room.preview) {
    const img = document.createElement('img');
    img.src = room.preview;
    img.alt = '';
    img.loading = 'lazy';
    cover.appendChild(img);
  } else {
    const scan = el('div', 'cover-scan');
    cover.appendChild(scan);
  }

  const shade = el('div', 'cover-shade');
  cover.appendChild(shade);

  const top = el('div', 'cover-top');
  const pill = el('div', 'platform-pill');
  const dot = el('span', 'platform-dot', platform.short || '网');
  dot.style.setProperty('--c1', c1);
  pill.appendChild(dot);
  pill.appendChild(el('span', '', platform.name));
  top.appendChild(pill);

  const fav = el('button', 'fav-btn' + (room.favorite ? ' is-fav' : ''));
  fav.type = 'button';
  fav.title = room.favorite ? '取消收藏' : '收藏';
  fav.setAttribute('aria-label', fav.title);
  fav.innerHTML = icons.star;
  fav.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    await api.toggleFavorite(room.id);
  });
  top.appendChild(fav);
  cover.appendChild(top);

  const hint = el('div', 'watch-hint');
  hint.innerHTML = icons.play + '<span>开始观看</span>';
  cover.appendChild(hint);

  const more = el('button', 'more-btn');
  more.type = 'button';
  more.title = '更多操作';
  more.setAttribute('aria-label', '更多操作');
  more.innerHTML = icons.more;
  more.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openContextMenu(room.id, more);
  });
  cover.appendChild(more);

  card.appendChild(cover);

  const body = el('div', 'room-body');
  const title = el('h3', 'room-title', room.displayName || '未命名直播间');
  body.appendChild(title);
  const meta = el('div', 'room-meta');
  meta.appendChild(el('span', 'room-source', hostOf(room.url)));
  const cleanTag = el('span', 'room-clean-tag');
  cleanTag.innerHTML = icons.clean + '<span>纯净画面</span>';
  meta.appendChild(cleanTag);
  body.appendChild(meta);
  card.appendChild(body);

  card.addEventListener('click', () => api.openRoom(room.id));
  card.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      api.openRoom(room.id);
    }
  });
  return card;
}

function makeAddCard() {
  const card = el('button', 'add-card');
  card.type = 'button';
  const icon = el('span', 'add-card-icon');
  icon.innerHTML = '<svg viewBox="0 0 20 20" fill="none"><path d="M10 4.25v11.5M4.25 10h11.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  card.appendChild(icon);
  card.appendChild(el('span', '', '添加另一个直播间'));
  card.addEventListener('click', () => openAdd());
  return card;
}

function render() {
  updateSidebar();
  const rooms = filteredRooms();
  updateStats(rooms);
  const grid = $('#roomGrid');
  const empty = $('#emptyState');
  const noResults = $('#noResults');
  grid.replaceChildren();

  if (!state.rooms.length) {
    empty.hidden = false;
    noResults.hidden = true;
    renderPlatformChips();
    return;
  }

  empty.hidden = true;
  if (!rooms.length) {
    noResults.hidden = false;
    renderNoResults();
    return;
  }
  noResults.hidden = true;

  rooms.forEach((room, i) => grid.appendChild(makeCard(room, i)));
  if (!query.trim() && currentView === 'all') grid.appendChild(makeAddCard());
}

function renderNoResults() {
  const h = $('#noResults h3');
  const p = $('#noResults p');
  const btn = $('#clearSearch');
  if (query.trim()) {
    noResultsAction = 'clear';
    h.textContent = '没有找到匹配的直播间';
    p.textContent = `没有与「${query.trim()}」相关的结果，换个关键词试试。`;
    btn.textContent = '清空搜索';
  } else if (currentView === 'favorites') {
    noResultsAction = 'all';
    h.textContent = '收藏夹还是空的';
    p.textContent = '点亮卡片右上角的星标，把常看的直播留在这里。';
    btn.textContent = '浏览全部直播间';
  } else {
    noResultsAction = 'all';
    h.textContent = '还没有观看记录';
    p.textContent = '打开任意一个直播间后，它会自动出现在这里。';
    btn.textContent = '浏览全部直播间';
  }
}

function applyState(next) {
  if (!next) return;
  state.rooms = next.rooms || [];
  state.settings = next.settings || state.settings;
  state.platforms = next.platforms || state.platforms;
  state.version = next.version || state.version;
  $('#versionText').textContent = state.version;
  $('#aboutVersion').textContent = 'v' + state.version;
  const sw = $('#cleanDefaultSwitch');
  if (sw) sw.setAttribute('aria-checked', state.settings.clean ? 'true' : 'false');
  render();
}

function showToast(message) {
  const toast = $('#toast');
  $('#toastText').textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}

function openModal(id) {
  activeModal = id;
  const layer = $('#modalLayer');
  layer.hidden = false;
  for (const modal of layer.querySelectorAll('.modal')) {
    modal.hidden = modal.id !== id;
  }
}

function closeModal() {
  activeModal = null;
  $('#modalLayer').hidden = true;
  $('#contextMenu').hidden = true;
  menuRoomId = null;
}

function resetForm() {
  $('#urlInput').value = '';
  $('#nameInput').value = '';
  $('#formError').hidden = true;
  $('#detectedPlatform').hidden = true;
  $('#submitRoom').disabled = false;
  $('#submitRoom').textContent = '添加到直播架';
}

function openAdd(prefill = '') {
  editingId = null;
  resetForm();
  $('#addModalEyebrow').textContent = 'ADD A CHANNEL';
  $('#addModalTitle').textContent = '添加直播间';
  $('#submitRoom').textContent = '添加到直播架';
  if (prefill) $('#urlInput').value = prefill;
  openModal('addModal');
  updateDetected();
  setTimeout(() => {
    $('#urlInput').focus();
    if (prefill) $('#urlInput').setSelectionRange(prefill.length, prefill.length);
  }, 30);
}

function openEdit(room) {
  editingId = room.id;
  resetForm();
  $('#addModalEyebrow').textContent = 'EDIT CHANNEL';
  $('#addModalTitle').textContent = '编辑直播间';
  $('#urlInput').value = room.url;
  $('#nameInput').value = room.name || '';
  $('#submitRoom').textContent = '保存修改';
  openModal('addModal');
  updateDetected();
  setTimeout(() => $('#urlInput').focus(), 30);
}

function updateDetected() {
  const raw = $('#urlInput').value.trim();
  const p = raw ? detectPlatform(raw) : null;
  const box = $('#detectedPlatform');
  if (!p || p.id === 'generic') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const badge = $('#detectedBadge');
  badge.textContent = p.short;
  badge.style.background = safeColor(p.color, '#82f3c5');
  $('#detectedName').textContent = p.name;
}

async function submitRoom(ev) {
  ev.preventDefault();
  const url = $('#urlInput').value.trim();
  const name = $('#nameInput').value.trim();
  const error = $('#formError');
  const button = $('#submitRoom');
  if (!url) {
    error.textContent = '请先粘贴直播间链接。';
    error.hidden = false;
    $('#urlInput').focus();
    return;
  }
  error.hidden = true;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = editingId ? '保存中…' : '添加中…';
  try {
    const result = editingId
      ? await api.updateRoom(editingId, { url, name })
      : await api.addRoom({ url, name });
    if (!result || !result.ok) {
      error.textContent = result?.error || '操作失败，请稍后重试。';
      if (result?.code === 'DUPLICATE' && result.room) {
        error.textContent = `这个直播间已经在列表里了：${result.room.displayName}`;
      }
      error.hidden = false;
      button.disabled = false;
      button.textContent = original;
      return;
    }
    const wasEditing = !!editingId;
    closeModal();
    showToast(wasEditing ? '修改已保存' : '已添加，正在获取直播间标题');
  } catch (e) {
    error.textContent = '操作失败：' + (e?.message || '未知错误');
    error.hidden = false;
    button.disabled = false;
    button.textContent = original;
  }
}

function openContextMenu(id, anchor) {
  const room = state.rooms.find((r) => r.id === id);
  if (!room) return;
  menuRoomId = id;
  const menu = $('#contextMenu');
  menu.replaceChildren();

  const addItem = (icon, label, action, danger = false) => {
    const btn = el('button', 'menu-item' + (danger ? ' danger' : ''));
    btn.type = 'button';
    btn.innerHTML = (icon || '') + `<span>${label}</span>`;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hideContextMenu();
      action();
    });
    menu.appendChild(btn);
  };
  const sep = () => menu.appendChild(el('div', 'menu-sep'));

  addItem(icons.play, '开始观看', () => api.openRoom(room.id));
  addItem(icons.star, room.favorite ? '取消收藏' : '加入收藏', () => api.toggleFavorite(room.id));
  addItem(icons.edit, '编辑直播间', () => openEdit(room));
  sep();
  addItem(icons.copy, '复制链接', () => { api.copy(room.url); showToast('链接已复制'); });
  addItem(icons.external, '在浏览器打开', () => api.openExternal(room.url));
  sep();
  addItem(icons.trash, '从列表移除', () => openDelete(room), true);

  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let left = Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 10);
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 10) top = rect.top - menuRect.height - 6;
  menu.style.left = Math.max(10, left) + 'px';
  menu.style.top = Math.max(10, top) + 'px';
}

function hideContextMenu() {
  $('#contextMenu').hidden = true;
  menuRoomId = null;
}

function openDelete(room) {
  deleteTargetId = room.id;
  $('#confirmTitle').textContent = '删除这个直播间？';
  $('#confirmText').textContent = `「${room.displayName}」将从列表中移除，直播站点本身不会受到影响。`;
  openModal('confirmModal');
}

async function confirmDelete() {
  if (!deleteTargetId) return;
  const id = deleteTargetId;
  deleteTargetId = null;
  closeModal();
  const res = await api.removeRoom(id);
  showToast(res?.ok ? '已从列表移除' : '删除失败');
}

async function loadAccounts() {
  const list = $('#accountList');
  if (!list) return;
  list.innerHTML = '<div class="account-loading">正在读取登录状态…</div>';
  try {
    const result = await api.getAccounts();
    const accounts = result?.accounts || [];
    list.replaceChildren();
    for (const account of accounts) {
      const row = el('div', 'account-row' + (account.loggedIn ? ' is-online' : ''));
      const mark = el('span', 'account-mark', account.short || '网');
      mark.style.background = safeColor(account.color, '#82f3c5');
      const info = el('div', 'account-info');
      info.appendChild(el('div', 'account-name', account.name));
      const status = el('div', 'account-status');
      status.appendChild(el('span', 'dot'));
      status.appendChild(el('span', '', account.loggedIn ? '已登录' : '未登录'));
      info.appendChild(status);
      row.appendChild(mark);
      row.appendChild(info);
      const action = el('button', 'account-action' + (account.loggedIn ? ' danger' : ''), account.loggedIn ? '退出' : '登录');
      action.type = 'button';
      action.addEventListener('click', async () => {
        if (account.loggedIn) {
          action.disabled = true;
          action.textContent = '退出中…';
          const res = await api.logoutAccount(account.id);
          if (res?.ok) showToast(`已退出 ${account.name}`);
          await loadAccounts();
        } else {
          const res = await api.loginAccount(account.id);
          if (res?.ok) {
            closeModal();
            showToast(`请在打开的页面完成 ${account.name} 登录，登录后点左上角返回`);
          } else {
            showToast(res?.error || '无法打开登录页面');
          }
        }
      });
      row.appendChild(action);
      list.appendChild(row);
    }
    if (!accounts.length) {
      list.innerHTML = '<div class="account-loading">暂无可管理的账号</div>';
    }
  } catch {
    list.innerHTML = '<div class="account-loading">读取登录状态失败</div>';
  }
}

function openSettings() {
  const sw = $('#cleanDefaultSwitch');
  sw.setAttribute('aria-checked', state.settings.clean ? 'true' : 'false');
  openModal('settingsModal');
  loadAccounts();
}

function setView(view) {
  if (!views[view]) return;
  currentView = view;
  query = '';
  $('#searchInput').value = '';
  render();
}

function extractUrl(text) {
  const value = String(text || '').trim();
  const match = value.match(/https?:\/\/[^\s"'<>]+/i);
  if (match) return match[0].replace(/[),.;]+$/, '');
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(value)) return value;
  return '';
}

function hideDropOverlay() {
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
}

function wireDragAndDrop() {
  const hasLink = (event) => {
    const types = Array.from(event.dataTransfer?.types || []);
    return types.includes('text/uri-list') || types.includes('text/plain') || types.includes('Files');
  };

  document.addEventListener('dragenter', (event) => {
    if (activeModal || !hasLink(event)) return;
    event.preventDefault();
    dragDepth++;
    $('#dropOverlay').hidden = false;
  });

  document.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragleave', (event) => {
    if (activeModal) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('#dropOverlay').hidden = true;
  });

  document.addEventListener('drop', (event) => {
    event.preventDefault();
    const wasVisible = !$('#dropOverlay').hidden;
    hideDropOverlay();
    if (activeModal || !wasVisible) return;
    const data = event.dataTransfer;
    const text = data?.getData('text/uri-list') || data?.getData('text/plain') || '';
    const url = extractUrl(text);
    if (!url) {
      showToast('没有从拖入的内容里找到直播间链接');
      return;
    }
    openAdd(url);
  });

  window.addEventListener('dragend', hideDropOverlay);
  window.addEventListener('blur', hideDropOverlay);
}

function wire() {
  wireDragAndDrop();
  $('#sidebarAdd').addEventListener('click', () => openAdd());
  $('#topAdd').addEventListener('click', () => openAdd());
  $('#openSettings').addEventListener('click', openSettings);

  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  $('#searchInput').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    const value = ev.target.value;
    searchTimer = setTimeout(() => {
      query = value;
      render();
    }, 80);
  });

  $('#quickAdd').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = $('#quickUrl').value.trim();
    $('#quickUrl').value = '';
    openAdd(value);
  });

  $('#clearSearch').addEventListener('click', () => {
    if (noResultsAction === 'all') {
      setView('all');
    } else {
      query = '';
      $('#searchInput').value = '';
      render();
    }
  });

  $('#roomForm').addEventListener('submit', submitRoom);
  $('#urlInput').addEventListener('input', updateDetected);
  $('#pasteBtn').addEventListener('click', async () => {
    const text = await api.paste();
    if (text) {
      $('#urlInput').value = text.trim();
      updateDetected();
      $('#urlInput').focus();
    } else {
      showToast('剪贴板里没有文本');
    }
  });

  document.querySelectorAll('[data-close]').forEach((node) => {
    node.addEventListener('click', closeModal);
  });

  $('#confirmDelete').addEventListener('click', confirmDelete);

  $('#cleanDefaultSwitch').addEventListener('click', async () => {
    const next = !state.settings.clean;
    state.settings.clean = next;
    $('#cleanDefaultSwitch').setAttribute('aria-checked', next ? 'true' : 'false');
    await api.setSetting({ clean: next });
    showToast(next ? '之后将默认使用纯净模式' : '之后将默认使用网页模式');
  });

  $('#openDataBtn').addEventListener('click', () => api.openDataFolder());
  $('#refreshAccounts').addEventListener('click', () => loadAccounts());

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#contextMenu') && !ev.target.closest('.more-btn')) hideContextMenu();
  });

  window.addEventListener('blur', hideContextMenu);
  document.querySelector('.content').addEventListener('scroll', hideContextMenu, { passive: true });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!$('#contextMenu').hidden) { hideContextMenu(); return; }
      if (activeModal) { closeModal(); return; }
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'n') {
      ev.preventDefault();
      openAdd();
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      $('#searchInput').focus();
      $('#searchInput').select();
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && activeModal === 'addModal') {
      ev.preventDefault();
      $('#roomForm').requestSubmit();
    }
  });

  window.addEventListener('resize', hideContextMenu);
}

async function boot() {
  wire();
  try {
    const initial = await api.getState();
    applyState(initial);
  } catch (e) {
    showToast('读取本地数据失败');
  }
  api.onState((next) => applyState(next));
  api.onPlayerActive((active) => document.body.classList.toggle('player-active', !!active));
}

boot();
