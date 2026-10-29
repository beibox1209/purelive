'use strict';

const api = window.player;
let currentState = null;
let toastTimer = null;
let aiSession = null;
let aiLoading = null;
let aiProcessing = false;
let aiCanvas = null;
let aiScratch = null;
let aiFrameCount = 0;
let aiFpsStart = 0;

const $ = (sel) => document.querySelector(sel);

function safeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function shortQuality(label) {
  const value = String(label || '').trim();
  if (!value) return '自动';
  const stripped = value.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
  const res = stripped.match(/^\d{3,4}P/i);
  if (res) return res[0].toUpperCase();
  return stripped.length > 9 ? stripped.slice(0, 9) : stripped;
}

function renderQualityMenu(state) {
  const options = $('#qualityOptions');
  const note = $('#qualityNote');
  const menu = $('#qualityMenu');
  if (!state || menu.hidden) return;
  $('#qualityPlatform').textContent = state.platform?.name || '直播间';
  options.replaceChildren();
  const qualities = Array.isArray(state.qualities) ? state.qualities : [];
  if (!qualities.length) {
    const empty = document.createElement('div');
    empty.className = 'quality-empty';
    empty.textContent = state.qualityBusy
      ? '正在读取清晰度…'
      : (state.qualityNote || '正在读取清晰度，或该站点暂不支持在纯净模式中切换。');
    options.appendChild(empty);
  } else {
    for (const q of qualities) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quality-option' + (q.current ? ' is-current' : '') + (q.locked ? ' is-locked' : '');
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', q.current ? 'true' : 'false');
      const radio = document.createElement('span');
      radio.className = 'quality-radio';
      const label = document.createElement('span');
      label.className = 'quality-option-label';
      label.textContent = q.label || q.id;
      btn.appendChild(radio);
      btn.appendChild(label);
      if (q.locked) {
        const tag = document.createElement('span');
        tag.className = 'quality-option-tag';
        tag.textContent = '登录';
        btn.appendChild(tag);
      }
      btn.addEventListener('click', () => {
        if (q.locked) {
          showToast('这个清晰度需要登录，请先切换到网页模式完成登录');
          return;
        }
        hideQualityMenu();
        api.setQuality(q.id);
      });
      options.appendChild(btn);
    }
    const currentOption = options.querySelector('.quality-option.is-current');
    if (currentOption) {
      requestAnimationFrame(() => {
        try { currentOption.scrollIntoView({ block: 'nearest' }); } catch {}
      });
    }
  }
  note.hidden = !state.qualityNote || !qualities.length;
  note.textContent = state.qualityNote || '';
  positionQualityMenu();
}

function positionQualityMenu() {
  const menu = $('#qualityMenu');
  if (menu.hidden) return;
  const btn = $('#qualityBtn');
  const rect = btn.getBoundingClientRect();
  const width = menu.offsetWidth || 242;
  const height = menu.offsetHeight || 200;
  let left = rect.right - width;
  left = Math.max(10, Math.min(left, window.innerWidth - width - 12));
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 10) top = Math.max(58, rect.top - height - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function showQualityMenu() {
  const menu = $('#qualityMenu');
  menu.hidden = false;
  $('#qualityBtn').setAttribute('aria-expanded', 'true');
  renderQualityMenu(currentState);
  api.refreshQuality().catch(() => {});
}

function hideQualityMenu() {
  $('#qualityMenu').hidden = true;
  $('#qualityBtn').setAttribute('aria-expanded', 'false');
}

function base64ToBlob(base64, type) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function ensureAiSession() {
  if (aiSession) return aiSession;
  if (aiLoading) return aiLoading;
  aiLoading = (async () => {
    if (!window.ort) throw new Error('AI 运行库未加载');
    ort.env.wasm.wasmPaths = new URL('ai/', location.href).href;
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    aiSession = await ort.InferenceSession.create('ai/super-resolution.onnx', {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return aiSession;
  })();
  try {
    return await aiLoading;
  } finally {
    aiLoading = null;
  }
}

function updateAiBadge(text) {
  const badge = $('#aiBadge');
  const label = $('#aiBadgeText');
  if (badge) badge.hidden = false;
  if (label) label.textContent = text;
}

function startAiUi() {
  const canvas = $('#aiCanvas');
  if (canvas) {
    const stage = document.querySelector('.stage');
    canvas.hidden = false;
    canvas.width = Math.max(2, Math.round(stage?.clientWidth || innerWidth));
    canvas.height = Math.max(2, Math.round(stage?.clientHeight || (innerHeight - 54)));
  }
  updateAiBadge('AI 超分 · 准备中');
  aiFpsStart = 0;
  aiFrameCount = 0;
}

function stopAiUi() {
  const canvas = $('#aiCanvas');
  if (canvas) {
    canvas.hidden = true;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  const badge = $('#aiBadge');
  if (badge) badge.hidden = true;
}

async function handleAiFrame(frame) {
  if (aiProcessing || !frame || !frame.data) return;
  aiProcessing = true;
  try {
    const session = await ensureAiSession();
    const bitmap = await createImageBitmap(base64ToBlob(frame.data, 'image/jpeg'));

    const inputCanvas = document.createElement('canvas');
    inputCanvas.width = 224;
    inputCanvas.height = 224;
    const inputCtx = inputCanvas.getContext('2d', { willReadFrequently: true });
    inputCtx.drawImage(bitmap, 0, 0, 224, 224);
    const inputImage = inputCtx.getImageData(0, 0, 224, 224);
    const inputData = new Float32Array(224 * 224);
    for (let i = 0, p = 0; i < inputImage.data.length; i += 4, p++) {
      inputData[p] = (0.299 * inputImage.data[i] + 0.587 * inputImage.data[i + 1] + 0.114 * inputImage.data[i + 2]) / 255;
    }
    const tensor = new ort.Tensor('float32', inputData, [1, 1, 224, 224]);
    const outputs = await session.run({ input: tensor });
    const output = outputs.output || outputs[Object.keys(outputs)[0]];
    const outData = output.data;

    if (!aiScratch) {
      aiScratch = document.createElement('canvas');
      aiScratch.width = 672;
      aiScratch.height = 672;
    }
    const srcCtx = aiScratch.getContext('2d', { willReadFrequently: true });
    srcCtx.drawImage(bitmap, 0, 0, 672, 672);
    const srcImage = srcCtx.getImageData(0, 0, 672, 672);
    const px = srcImage.data;

    let maxSample = 0;
    for (let i = 0; i < Math.min(4096, outData.length); i += 97) {
      if (outData[i] > maxSample) maxSample = outData[i];
    }
    const yScale = maxSample > 2 ? 1 : 255;

    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
      const y = Math.max(0, Math.min(255, outData[p] * yScale));
      px[i] = Math.max(0, Math.min(255, y + 1.402 * cr));
      px[i + 1] = Math.max(0, Math.min(255, y - 0.344136 * cb - 0.714136 * cr));
      px[i + 2] = Math.max(0, Math.min(255, y + 1.772 * cb));
      px[i + 3] = 255;
    }
    srcCtx.putImageData(srcImage, 0, 0);

    const aspect = Number(frame.aspect) > 0.1 ? Number(frame.aspect) : 16 / 9;
    const contentW = aspect >= 1 ? 672 : 672 * aspect;
    const contentH = aspect >= 1 ? 672 / aspect : 672;
    const sx = (672 - contentW) / 2;
    const sy = (672 - contentH) / 2;

    const canvas = $('#aiCanvas');
    if (!canvas || canvas.hidden) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / contentW, canvas.height / contentH);
    const dw = contentW * scale;
    const dh = contentH * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(aiScratch, sx, sy, contentW, contentH, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);

    aiFrameCount++;
    const now = Date.now();
    if (!aiFpsStart) aiFpsStart = now;
    if (now - aiFpsStart >= 1000) {
      const fps = Math.max(1, Math.round((aiFrameCount * 1000) / (now - aiFpsStart)));
      updateAiBadge(`AI 超分 · ${fps} fps`);
      aiFrameCount = 0;
      aiFpsStart = now;
    }
  } catch (e) {
    api.aiError(e.message || String(e));
  } finally {
    aiProcessing = false;
    api.aiFrameDone();
  }
}

function render(state) {
  currentState = state;
  document.body.classList.toggle('login-mode', !!state?.loginMode);
  if (!state || !state.room) return;
  const room = state.room;
  const platform = state.platform || { name: '网页直播', short: '网', color: '#82f3c5' };
  const color = safeColor(platform.color, '#82f3c5');

  $('#roomTitle').textContent = room.displayName || room.name || '直播间';
  $('#roomTitle').title = room.displayName || room.name || '直播间';
  $('#platformMark').textContent = platform.short || '网';
  $('#platformMark').style.background = color;
  $('#loaderMark').textContent = platform.short || '网';
  $('#loaderMark').style.color = color;
  $('#loaderOrb').style.borderColor = color;

  const host = hostOf(room.url);
  $('#roomHost').textContent = host ? `${host}  ·  ${state.clean ? 'CLEAN VIEW' : 'WEB VIEW'}` : 'PURELIVE';
  $('#modePill').textContent = state.clean ? '纯净' : '网页';
  $('#modePill').style.color = state.clean ? '#6bd8ac' : '#8fb9ff';
  $('#modePill').style.borderColor = state.clean ? 'rgba(130,243,197,.16)' : 'rgba(143,185,255,.2)';
  $('#modePill').style.background = state.clean ? 'rgba(130,243,197,.055)' : 'rgba(143,185,255,.07)';

  $('#cleanBtn').classList.toggle('is-on', !!state.clean);
  $('#cleanBtn').setAttribute('aria-checked', state.clean ? 'true' : 'false');
  $('#cleanBtn').title = state.clean ? '纯净模式已开启，点击切换为网页模式' : '网页模式，点击开启纯净模式';

  const qualityLabel = state.qualityLabel || (state.qualities || []).find((q) => q.current)?.label || '';
  $('#qualityValue').textContent = state.qualityBusy ? '切换中' : shortQuality(qualityLabel);
  $('#qualityBtn').classList.toggle('is-busy', !!state.qualityBusy);
  $('#qualityBtn').classList.toggle('is-enhanced', !!state.enhance);
  $('#qualityBtn').title = (qualityLabel ? `当前清晰度：${qualityLabel}` : '调整清晰度') + (state.enhance ? ' · 实时增强已开启' : '');
  const enhanceBtn = $('#enhanceBtn');
  if (enhanceBtn) {
    enhanceBtn.classList.toggle('is-on', !!state.enhance);
    enhanceBtn.title = state.enhance ? '实时画质增强已开启' : '开启实时画质增强（GPU）';
  }
  if (!$('#qualityMenu').hidden) renderQualityMenu(state);

  document.body.classList.toggle('is-muted', !!state.muted);
  document.body.classList.toggle('is-playing', state.paused === false);
  $('#muteBtn').classList.toggle('is-active', !!state.muted);
  $('#muteBtn').title = state.muted ? '取消静音（M）' : '静音（M）';
  $('#pinBtn').classList.toggle('is-active', !!state.pinned);
  $('#fullscreenBtn').classList.toggle('is-active', !!state.fullscreen);
  $('#playBtn').disabled = state.mediaType !== 'video';
  $('#playBtn').title = state.mediaType === 'video'
    ? (state.paused ? '播放（空格）' : '暂停（空格）')
    : '这个直播间使用内嵌播放器，请直接在画面中操作';

  const loading = $('#loadingView');
  const error = $('#errorView');
  const hint = $('#stageHint');
  if (state.error) {
    loading.hidden = true;
    error.hidden = false;
    hint.hidden = true;
    let title = '画面暂时没有接通';
    if (state.error.offline) title = '主播暂未开播';
    else if (state.error.needsLogin) title = '需要登录或验证';
    else if (state.error.noMedia) title = '没有认出直播画面';
    $('#errorTitle').textContent = title;
    $('#errorText').textContent = state.error.message || '请检查网络后重试。';
    $('#webModeBtn').hidden = !state.clean;
    if (state.error.offline) {
      $('#errorNote').textContent = '网页模式可以查看直播间公告、回放和下次开播时间。';
    } else if (state.error.needsLogin) {
      $('#errorNote').textContent = '在网页模式完成登录或验证后，再切回纯净模式即可继续观看。';
    } else {
      $('#errorNote').textContent = state.clean
        ? '网页模式会显示直播站点的完整界面，适合登录、选择画质或处理站点提示。'
        : '你已经在网页模式中，可以尝试刷新，或在浏览器中打开这个直播间。';
    }
  } else if (state.loading) {
    loading.hidden = false;
    error.hidden = true;
    hint.hidden = true;
    $('#loadingText').textContent = state.clean
      ? '正在移开聊天、礼物与推荐，只留下直播本身。'
      : '正在打开直播站点，网页界面会完整显示。';
  } else {
    loading.hidden = true;
    error.hidden = true;
    hint.hidden = !state.ready || !state.clean;
  }

  if (state.clean) {
    $('#stageHint').lastChild.textContent = ' 画面区域已净化 · 聊天 / 礼物 / 推荐不会出现';
  } else {
    $('#stageHint').lastChild.textContent = ' 网页模式 · 直播站点界面完整显示';
  }

  document.title = `${room.displayName || '直播间'} · 净播`;
}

function showToast(message) {
  const toast = $('#toast');
  $('#toastText').textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}

function hideMenu() {
  $('#playerMenu').hidden = true;
}

function wire() {
  $('#backBtn').addEventListener('click', () => api.close());
  $('#playBtn').addEventListener('click', () => api.togglePlay());
  $('#muteBtn').addEventListener('click', () => api.toggleMute());
  $('#cleanBtn').addEventListener('click', () => api.toggleClean());
  $('#enhanceBtn').addEventListener('click', () => api.toggleEnhance());
  $('#reloadBtn').addEventListener('click', () => api.reload());
  $('#pinBtn').addEventListener('click', () => api.togglePin());
  $('#fullscreenBtn').addEventListener('click', () => api.toggleFullscreen());
  $('#retryBtn').addEventListener('click', () => api.retry());
  $('#webModeBtn').addEventListener('click', () => {
    $('#webModeBtn').disabled = true;
    api.setClean(false);
    setTimeout(() => { $('#webModeBtn').disabled = false; }, 800);
  });

  $('#moreBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    hideQualityMenu();
    hideMenu();
    const rect = $('#moreBtn').getBoundingClientRect();
    api.showMoreMenu({ x: rect.right - 210, y: rect.bottom + 6 }).catch(() => {});
  });

  $('#qualityBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    hideMenu();
    hideQualityMenu();
    const rect = $('#qualityBtn').getBoundingClientRect();
    api.showQualityMenu({ x: rect.left, y: rect.bottom + 6 }).catch(() => {});
  });

  $('#qualityWeb').addEventListener('click', (ev) => {
    ev.stopPropagation();
    hideQualityMenu();
    $('#webModeBtn').disabled = false;
    api.setClean(false);
  });

  $('#playerMenu').addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-action]');
    if (!button) return;
    hideMenu();
    const action = button.dataset.action;
    if (action === 'copy') api.copyUrl();
    if (action === 'external') api.openExternal();
    if (action === 'home') api.home();
    if (action === 'close') api.close();
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#playerMenu') && !ev.target.closest('#moreBtn')) hideMenu();
    if (!ev.target.closest('#qualityMenu') && !ev.target.closest('#qualityBtn')) hideQualityMenu();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (!$('#playerMenu').hidden) { hideMenu(); return; }
      if (!$('#qualityMenu').hidden) { hideQualityMenu(); return; }
    }
  });
  window.addEventListener('blur', () => { hideMenu(); hideQualityMenu(); });
  window.addEventListener('resize', () => {
    if (!$('#qualityMenu').hidden) positionQualityMenu();
  });

  api.onState((next) => render(next));
  api.onToast((message) => showToast(message));
}

async function boot() {
  wire();
  try {
    const state = await api.getState();
    render(state);
  } catch {
    showToast('读取播放状态失败');
  }
}

boot();
