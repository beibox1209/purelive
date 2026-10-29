'use strict';

/**
 * The "theater" engine takes the actual media surface out of the streaming
 * page and places it in a black, full-viewport stage that is a sibling of
 * <body>. The rest of the page is made invisible. This is intentionally more
 * aggressive than CSS-only cleanup: chat, gift panels, overlays and click
 * targets cannot leak into the viewing surface because they are no longer
 * rendered at all. The stream element itself keeps playing.
 */
function buildTheaterScript(platform, options = {}) {
  const platformJson = JSON.stringify(platform || 'generic');
  const subframe = options.subframe === true;
  const targetWidth = Math.max(320, Number(options.width) || 1280);
  const targetHeight = Math.max(240, Number(options.height) || 720);
  const enhanceDefault = options.enhance === true;
  return `(() => {
  'use strict';
  const PLATFORM = ${platformJson};
  const SUBFRAME = ${subframe ? 'true' : 'false'};
  const TARGET = { w: ${targetWidth}, h: ${targetHeight} };
  const ENHANCE_DEFAULT = ${enhanceDefault ? 'true' : 'false'};
  const FLAG = '__pureliveTheater';
  if (window[FLAG] && window[FLAG].version === 1) {
    window[FLAG].refresh();
    return 'refreshed';
  }
  const state = {
    version: 1,
    stage: null,
    media: null,
    candidate: null,
    timer: 0,
    tick: 0,
    rehomes: 0,
    switches: 0,
    mediaScore: 0,
    lastSwitch: 0,
    idleTimer: 0,
    observer: null,
    lastCandidates: [],
    adoptedAt: 0,
    createdAt: Date.now(),
    mediaPreferred: false,
    userPaused: false,
    enhance: ENHANCE_DEFAULT,
    enhanceCanvas: null,
    enhanceGl: null,
    enhanceRaf: 0,
    enhanceVideo: null,
  };
  window[FLAG] = state;

  const PREFERRED = {
    bilibili: ['#live-player video', '.bilibili-live-player video', '#live-player iframe'],
    douyu: ['#__video2', '.js-player-video video', '.js-player-video-core video'],
    huya: ['#hy-video', '#player-mouse-event-wrap video', '#player-wrap video'],
    douyin: ['.xg-video-container video', '.xgplayer video', '#slidelist video'],
    twitch: ['[data-a-target="video-player"] video', '.video-player video'],
    youtube: ['.html5-main-video', '#movie_player video'],
    kick: ['#video-player video', '.video-player video'],
  };

  const viewport = () => ({
    w: window.innerWidth > 0 ? window.innerWidth : TARGET.w,
    h: window.innerHeight > 0 ? window.innerHeight : TARGET.h,
  });

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || Number(cs.opacity) === 0) return false;
    if (el.style && el.style.visibility === 'hidden') return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    // Ignore a hidden <body> (we hide it ourselves after adoption), but respect
    // an explicitly hidden wrapper inside the page.
    let p = el.parentElement;
    while (p && p !== document.body) {
      const pcs = getComputedStyle(p);
      if (pcs.display === 'none') return false;
      p = p.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 40;
  };

  const classAndId = (el) => ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
  const playerish = (el) => /(player|video|stream|live|stage|screen|movie|player-wrap|player-container)/i.test(classAndId(el));
  const adish = (el) => /(advert|ad-content|ad-container|ab-content|ab-video|ads|banner|hero|promo|carousel|preview)/i.test(classAndId(el));

  function collectMedia() {
    const out = [];
    const visit = (root) => {
      if (!root || !root.querySelectorAll) return;
      for (const el of root.querySelectorAll('video, iframe')) out.push(el);
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return out;
  }

  function score(el, vp) {
    if (state.stage && state.stage.contains(el)) return -1;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < 45000) return -1;
    if (r.width < 180 || r.height < 100) return -1;
    if (r.right < 0 || r.bottom < 0 || r.left > vp.w + 80 || r.top > vp.h * 2.2) return -1;
    if (el.tagName === 'IFRAME' && /(doubleclick|googlesyndication|adsystem|adservice|facebook\\.com\\/tr)/i.test(el.src || '')) return -1;
    let s = Math.min(area, vp.w * vp.h * 1.5);
    const mediaUrl = (el.currentSrc || el.src || '').toLowerCase();
    if (/(adsmind|gdtimg|doubleclick|googlesyndication|adservice|admaster|adnxs|taboola)/.test(mediaUrl)) s *= 0.01;
    if (el.tagName === 'VIDEO' && /(^|\\s)(ab-video|ad-video|ads-video)/.test(classAndId(el))) s *= 0.05;
    const ratio = r.width / Math.max(1, r.height);
    const ratioPenalty = Math.abs(ratio - 16 / 9);
    s *= Math.max(0.3, 1 - ratioPenalty * 0.32);
    if (ratio > 2.15 || ratio < 1.05) s *= 0.2;
    if (el.tagName === 'IFRAME') s *= 0.62;
    let a = el.parentElement;
    let hasPlayerAncestor = false;
    for (let i = 0; i < 8 && a; i++, a = a.parentElement) {
      if (playerish(a)) { hasPlayerAncestor = true; break; }
      if (adish(a)) { s *= 0.2; break; }
    }
    if (hasPlayerAncestor) s *= 1.8;
    if (el.tagName === 'VIDEO') {
      if (el.readyState > 0) s *= 1.15;
      if (!el.paused) s *= 1.2;
      if (el.muted || el.volume === 0) s *= 0.72;
      if (Number.isFinite(el.duration) && el.duration > 0) s *= 0.76;
      if (el.loop) s *= 0.32;
      if (/(nicebackground|background-video|bg-video|backdrop|decorative|hero-bg|page-bg)/i.test(classAndId(el))) s *= 0.12;
      if (!hasPlayerAncestor && !el.controls) s *= 0.72;
    }
    const preferred = PREFERRED[PLATFORM] || [];
    for (let i = 0; i < preferred.length; i++) {
      try { if (el.matches(preferred[i])) { s *= (1.8 - i * 0.2); break; } } catch (e) {}
    }
    return s;
  }

  function choose() {
    const vp = viewport();
    let best = null;
    let bestScore = -1;
    const preferredSelectors = PREFERRED[PLATFORM] || [];
    const currentInStage = state.media && state.media.isConnected && state.stage && state.stage.contains(state.media);
    const currentIsPreferred = currentInStage && (state.mediaPreferred || preferredSelectors.some((sel) => {
      try { return state.media.matches(sel); } catch (e) { return false; }
    }));

    function findPreferred() {
      let found = null;
      let foundScore = -1;
      for (const sel of preferredSelectors) {
        let nodes = [];
        try { nodes = [...document.querySelectorAll(sel)]; } catch (e) {}
        for (const el of nodes) {
          if (state.stage && state.stage.contains(el)) continue;
          if (!isVisible(el)) continue;
          const s = score(el, vp);
          if (s > foundScore) { foundScore = s; found = el; }
        }
      }
      return { el: found, score: foundScore };
    }

    if (currentIsPreferred) return state.media;

    if (preferredSelectors.length) {
      const pref = findPreferred();
      if (pref.el && (!currentInStage || state.switches < 3)) {
        state.switches += currentInStage ? 1 : 0;
        state.mediaScore = pref.score;
        state.adoptedAt = Date.now();
        return pref.el;
      }
      // Known platform: give the real player a moment to mount instead of
      // grabbing a full-size ad or a background video.
      if (!currentInStage && Date.now() - state.createdAt < 9000) return null;
    }

    const candidates = [];
    for (const el of collectMedia()) {
      if (!isVisible(el)) continue;
      const s = score(el, vp);
      if (s <= 0) continue;
      candidates.push({ el, s, id: el.id || '', cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) });
      if (s > bestScore) { bestScore = s; best = el; }
    }
    candidates.sort((a, b) => b.s - a.s);
    state.lastCandidates = candidates.slice(0, 8);
    if (currentInStage) {
      const current = state.media;
      const canSwitch = state.switches < 3 && Date.now() - state.adoptedAt < 20000;
      const clearlyBetter = best && best !== current && bestScore > state.mediaScore * 1.55 && bestScore > vp.w * vp.h * 0.12;
      const currentDead = current.tagName === 'VIDEO' && current.ended;
      if ((clearlyBetter && canSwitch) || currentDead) {
        state.switches++;
        state.mediaScore = bestScore;
        state.adoptedAt = Date.now();
        return best;
      }
      return current;
    }
    if (best) {
      state.mediaScore = bestScore;
      state.adoptedAt = Date.now();
    }
    return best;
  }

  function createStage() {
    const stage = document.createElement('div');
    stage.id = 'purelive-theater-stage';
    stage.setAttribute('data-purelive-theater', '1');
    stage.style.cssText = [
      'position:fixed', 'inset:0', 'width:' + TARGET.w + 'px', 'height:' + TARGET.h + 'px',
      'background:#000', 'z-index:2147483647', 'overflow:hidden',
      'margin:0', 'padding:0', 'border:0', 'display:block',
      'visibility:visible', 'isolation:isolate', 'pointer-events:auto',
    ].join('!important;') + '!important;';
    stage.addEventListener('click', (ev) => {
      if (ev.target === state.media || ev.target?.tagName === 'VIDEO' || ev.target?.id === 'purelive-enhance-canvas') {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }, true);
    document.documentElement.appendChild(stage);
    return stage;
  }

  function styleMedia(el, vp) {
    const css = [
      'position:absolute', 'inset:0', 'left:0', 'top:0', 'width:100%', 'height:100%',
      'max-width:none', 'max-height:none', 'min-width:0', 'min-height:0',
      'margin:0', 'padding:0', 'border:0', 'border-radius:0',
      'object-fit:contain', 'background:#000', 'transform:none', 'opacity:1',
      'visibility:visible', 'display:block', 'z-index:1',
    ];
    for (const decl of css) {
      const i = decl.indexOf(':');
      el.style.setProperty(decl.slice(0, i), decl.slice(i + 1), 'important');
    }
    el.setAttribute('data-purelive-media', '1');
  }

  function hidePage() {
    document.documentElement.classList.add('purelive-theater');
    let style = document.getElementById('purelive-theater-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'purelive-theater-style';
      style.textContent = \`
        html.purelive-theater { background:#000!important; overflow:hidden!important; }
        html.purelive-theater body { visibility:hidden!important; overflow:hidden!important; background:#000!important; }
        html.purelive-theater #purelive-theater-stage,
        html.purelive-theater #purelive-theater-stage * { visibility:visible!important; }
        html.purelive-theater ::-webkit-scrollbar { width:0!important;height:0!important;display:none!important; }
        html.purelive-theater.pl-cursor-idle, html.purelive-theater.pl-cursor-idle * { cursor:none!important; }
      \`;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function muteOthers(selected) {
    for (const v of collectMedia()) {
      if (v !== selected && v.tagName === 'VIDEO' && !state.stage.contains(v)) {
        try { v.muted = true; } catch (e) {}
      }
    }
  }

  function adopt(media) {
    if (!media || !state.stage) return;
    const preferredSelectors = PREFERRED[PLATFORM] || [];
    state.mediaPreferred = preferredSelectors.some((sel) => {
      try { return media.matches(sel); } catch (e) { return false; }
    });
    if (state.media && state.media !== media && state.stage.contains(state.media)) {
      try { state.stage.removeChild(state.media); } catch (e) {}
    }
    if (!state.stage.contains(media)) {
      try {
        state.stage.appendChild(media);
        state.rehomes++;
      } catch (e) {
        console.warn('[PureLive] could not move media', e);
        return;
      }
    }
    state.media = media;
    const vp = viewport();
    styleMedia(media, vp);
    if (media.tagName === 'VIDEO') {
      try {
        if (media.muted) media.muted = false;
        if (!media.volume) media.volume = 1;
        if (media.paused) media.play().catch(() => {});
      } catch (e) {}
      media.addEventListener('play', () => {
        if (state.userPaused) {
          try { media.pause(); } catch (e) {}
        }
      }, true);
      media.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      }, true);
      if (state.userPaused) {
        try { media.pause(); } catch (e) {}
      }
    }
    muteOthers(media);
    if (state.enhance) startEnhance();
  }

  function refresh() {
    if (!document.documentElement) return;
    if (!state.stage && !SUBFRAME) state.stage = createStage();
    if (state.stage) {
      const vp = viewport();
      state.stage.style.setProperty('width', vp.w + 'px', 'important');
      state.stage.style.setProperty('height', vp.h + 'px', 'important');
    }
    const media = choose();
    if (media) {
      if (!state.stage) state.stage = createStage();
      state.candidate = media;
      if (state.media !== media || !state.stage.contains(media)) {
        adopt(media);
        hidePage();
      }
    }
    // Some sites rebuild the player and evict our element; recover.
    if (state.media && (!state.media.isConnected || !state.stage.contains(state.media))) {
      if (state.rehomes < 30) {
        adopt(state.media);
        hidePage();
      }
    }
    state.tick++;
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      try { refresh(); } catch (e) { console.warn('[PureLive]', e); }
    }, 180);
  }

  function setupCursor() {
    const wake = () => {
      document.documentElement.classList.remove('pl-cursor-idle');
      clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => document.documentElement.classList.add('pl-cursor-idle'), 2200);
    };
    window.addEventListener('mousemove', wake, { passive: true });
    window.addEventListener('pointerdown', wake, { passive: true });
    wake();
  }

  if (!SUBFRAME) state.stage = createStage();
  setTimeout(refresh, SUBFRAME ? 300 : 700);
  setTimeout(refresh, 1600);
  setTimeout(refresh, 3200);
  setTimeout(refresh, 6000);
  if (!state.observer) {
    state.observer = new MutationObserver(() => schedule());
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  setInterval(() => { try { refresh(); } catch (e) {} }, 2200);
  window.addEventListener('resize', () => {
    if (state.stage) {
      const vp = viewport();
      state.stage.style.setProperty('width', vp.w + 'px', 'important');
      state.stage.style.setProperty('height', vp.h + 'px', 'important');
    }
    if (state.media) styleMedia(state.media, viewport());
    schedule();
  }, { passive: true });
  function stopEnhance() {
    if (state.enhanceRaf) {
      cancelAnimationFrame(state.enhanceRaf);
      state.enhanceRaf = 0;
    }
    if (state.enhanceCanvas && state.enhanceCanvas.parentNode) {
      state.enhanceCanvas.parentNode.removeChild(state.enhanceCanvas);
    }
    state.enhanceCanvas = null;
    state.enhanceGl = null;
    const v = state.enhanceVideo;
    state.enhanceVideo = null;
    if (v && v.isConnected) {
      try { v.style.setProperty('opacity', '1', 'important'); } catch (e) {}
    }
  }

  function startEnhance() {
    if (!state.enhance || !state.media || state.media.tagName !== 'VIDEO' || !state.stage) return;
    stopEnhance();
    const video = state.media;
    const canvas = document.createElement('canvas');
    canvas.id = 'purelive-enhance-canvas';
    canvas.style.cssText = 'position:absolute!important;inset:0!important;width:100%!important;height:100%!important;display:block!important;z-index:2!important;background:#000!important;pointer-events:none!important;';
    state.stage.appendChild(canvas);

    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) {
      canvas.remove();
      return;
    }

    const VS = [
      '#version 300 es',
      'in vec2 aPos;',
      'out vec2 vUv;',
      'void main() {',
      '  vUv = aPos * 0.5 + 0.5;',
      '  gl_Position = vec4(aPos, 0.0, 1.0);',
      '}',
    ].join('\\n');
    const FS = [
      '#version 300 es',
      'precision highp float;',
      'uniform sampler2D uTex;',
      'uniform vec2 uTexel;',
      'in vec2 vUv;',
      'out vec4 outColor;',
      'void main() {',
      '  vec3 c = texture(uTex, vUv).rgb;',
      '  vec3 n = texture(uTex, vUv + vec2(0.0, -uTexel.y)).rgb;',
      '  vec3 s = texture(uTex, vUv + vec2(0.0,  uTexel.y)).rgb;',
      '  vec3 w = texture(uTex, vUv + vec2(-uTexel.x, 0.0)).rgb;',
      '  vec3 e = texture(uTex, vUv + vec2( uTexel.x, 0.0)).rgb;',
      '  vec3 blur = (n + s + w + e) * 0.25;',
      '  vec3 sharp = c + (c - blur) * 1.28;',
      '  float luma = dot(sharp, vec3(0.299, 0.587, 0.114));',
      '  sharp = mix(vec3(luma), sharp, 1.07);',
      '  sharp = clamp((sharp - 0.5) * 1.025 + 0.5, 0.0, 1.0);',
      '  outColor = vec4(sharp, 1.0);',
      '}',
    ].join('\\n');

    function compile(type, source) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn('[PureLive] enhance shader', gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    }
    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) {
      canvas.remove();
      return;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      canvas.remove();
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);
    const texelLoc = gl.getUniformLocation(program, 'uTexel');

    state.enhanceCanvas = canvas;
    state.enhanceGl = gl;
    state.enhanceVideo = video;
    try { video.style.setProperty('opacity', '0', 'important'); } catch (e) {}

    function resize() {
      const rect = state.stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = Math.max(2, Math.min(1920, Math.round(rect.width * dpr)));
      const h = Math.max(2, Math.min(1200, Math.round(rect.height * dpr)));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }

    function frame() {
      if (!state.enhance || state.enhanceCanvas !== canvas) return;
      if (!video.isConnected || video.readyState < 2 || !video.videoWidth) {
        state.enhanceRaf = requestAnimationFrame(frame);
        return;
      }
      resize();
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const vw = video.videoWidth, vh = video.videoHeight;
      const scale = Math.min(canvas.width / vw, canvas.height / vh);
      const dw = Math.max(1, Math.round(vw * scale));
      const dh = Math.max(1, Math.round(vh * scale));
      gl.viewport(Math.round((canvas.width - dw) / 2), Math.round((canvas.height - dh) / 2), dw, dh);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); } catch (e) {}
      gl.uniform2f(texelLoc, 1 / Math.max(1, vw), 1 / Math.max(1, vh));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      state.enhanceRaf = requestAnimationFrame(frame);
    }
    frame();
  }

  state.setEnhance = (on) => {
    state.enhance = !!on;
    if (state.enhance) {
      startEnhance();
      if (!state.enhanceCanvas) state.enhance = false;
    } else {
      stopEnhance();
    }
    return state.enhance;
  };
  state.isEnhanced = () => !!state.enhance;
  state.refresh = refresh;
  state.setPaused = (paused) => {
    const m = state.media;
    if (!m || m.tagName !== 'VIDEO') return null;
    state.userPaused = !!paused;
    try {
      if (paused) m.pause();
      else m.play().catch(() => {});
    } catch (e) {}
    return state.userPaused;
  };
  state.getPaused = () => {
    if (state.userPaused) return true;
    return !!(state.media && state.media.tagName === 'VIDEO' && state.media.paused);
  };
  setupCursor();
  return 'theater-installed';
})();`;
}

module.exports = { buildTheaterScript };
