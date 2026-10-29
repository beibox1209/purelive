'use strict';

// Runs before the streaming page scripts. PureLive only needs HTTP(S) playback.
// Blocking WebRTC prevents local UDP sockets (Windows firewall prompt) and P2P
// uploads; sites fall back to their regular HTTP streams.
const { webFrame } = require('electron');

try {
  webFrame.executeJavaScript(`(() => {
    const deny = function () {
      throw new DOMException('WebRTC is disabled in PureLive', 'NotAllowedError');
    };
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
      try {
        Object.defineProperty(window, name, { value: deny, writable: false, configurable: false });
      } catch (e) {}
    }
  })()`);
} catch {}
