/* Room — 大廳 + 房間（WebRTC mesh：麥克風語音、1080p/120fps 螢幕分享） */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const state = {
    socket: null,
    myId: null,
    room: null,            // { id, code, name }
    participants: [],
    peers: new Map(),      // peerId -> { pc, polite, makingOffer, ignoreOffer, videoStream, stats, connState }
    micStream: null,
    micTrack: null,
    micMuted: false,
    screenStream: null,
    screenTrack: null,
    quality: 'ultra',
    statsTimer: null,
    updatingRoom: false,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  const tileEls = new Map();   // participantId -> tile DOM refs
  const audioEls = new Map();  // `${peerId}:${streamId}` -> <audio>

  /* ================= 小工具 ================= */

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function toast(msg, type = 'info') {
    const t = el('div', `toast toast-${type}`, msg);
    $('#toasts').appendChild(t);
    setTimeout(() => {
      t.classList.add('fade');
      setTimeout(() => t.remove(), 350);
    }, 3800);
  }

  function ack(ev, payload) {
    if (!state.socket || !state.socket.connected) {
      return Promise.resolve({
        ok: false,
        error: '尚未連上伺服器：請確認網址是終端機印出的埠號（例如 http://localhost:3001），或重新整理頁面',
      });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: false, error: '伺服器沒有回應，請確認房間伺服器（npm start）仍在執行' });
      }, 10000);
      state.socket.emit(ev, payload, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  function connLabel(peer) {
    if (!peer) return '';
    // 還沒有任何媒體要傳時不需要建立連線，不必顯示狀態
    const hasMedia =
      peer.pc.getSenders().some((s) => s.track) || peer.pc.getTransceivers().length > 0;
    if (!hasMedia) return '';
    switch (peer.connState) {
      case 'connected': return '';
      case 'failed': return '連線失敗';
      case 'disconnected': return '重新連線中…';
      case 'closed': return '';
      default: return '連線中…';
    }
  }

  /* ================= 畫質設定 ================= */

  function videoConstraintsFor(q) {
    if (q === 'text') return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } };
    if (q === 'saver') return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    // ultra：向系統要求 1080p／最高 120fps
    return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 120, max: 120 } };
  }

  function bitrateFor(q) {
    return q === 'ultra' ? 16_000_000 : q === 'text' ? 8_000_000 : 3_500_000;
  }

  function degradationFor(q) {
    if (q === 'text') return 'maintain-resolution';
    if (q === 'saver') return 'balanced';
    return 'maintain-framerate'; // 頻寬不足時降解析度、保住幀率
  }

  async function applySenderQuality(sender) {
    try {
      const p = sender.getParameters();
      if (!Array.isArray(p.encodings) || p.encodings.length === 0) p.encodings = [{}];
      const e = p.encodings[0];
      e.maxBitrate = bitrateFor(state.quality);
      e.maxFramerate = state.quality === 'ultra' ? 120 : state.quality === 'text' ? 60 : 30;
      e.networkPriority = 'high';
      e.priority = 'high';
      e.degradationPreference = degradationFor(state.quality);
      await sender.setParameters(p);
    } catch (err) {
      console.warn('setParameters failed:', err);
    }
  }

  // 連線建立後重送一次編碼參數：協商過程常會把事先設定的值蓋掉，導致接收端被砍到 30fps
  function reapplyVideoQuality(pc) {
    for (const s of pc.getSenders()) {
      if (s.track && s.track.kind === 'video') applySenderQuality(s);
    }
  }

  /* ================= Socket 事件 ================= */

  function bindSocket() {
    const s = state.socket;

    const setBadge = (text, cls) => {
      const b = document.querySelector('#conn-badge');
      if (b) {
        b.textContent = text;
        b.className = 'conn-badge' + (cls ? ' ' + cls : '');
      }
    };

    s.on('connect', () => setBadge('🟢 已連線', 'on'));
    s.on('disconnect', () => setBadge('🔴 連線中斷，嘗試重連…', 'off'));

    s.on('participants', (list) => {
      state.participants = list;
      if (state.room) {
        syncPeers(list);
        renderRoom();
      }
    });

    s.on('participant:joined', ({ name }) => toast(`${name} 加入了房間`, 'success'));

    s.on('participant:left', ({ name }) => toast(`${name} 離開了房間`));

    s.on('owner:changed', ({ ownerName }) => toast(`房主已離開，${ownerName} 成為新房主`));

    s.on('room:updated', ({ name, renamed, passwordChanged, participants }) => {
      if (state.room) state.room = { ...state.room, name };
      if (participants) {
        state.participants = participants;
        syncPeers(participants);
      }
      if (!state.updatingRoom) {
        if (renamed) toast(`房主已將房間名稱改為「${name}」`);
        if (passwordChanged) toast('房主已更新房間密碼');
      }
      renderRoom();
    });

    s.on('signal', ({ from, data }) => {
      onSignal(from, data).catch((err) => console.warn('signal error:', err));
    });

    s.on('connect_error', (err) => toast('連線中斷：' + err.message, 'error'));
  }

  /* ================= WebRTC（perfect negotiation）================= */

  function emitSignal(to, data) {
    state.socket.emit('signal', { to, data });
  }

  function syncPeers(list) {
    const ids = new Set(list.filter((p) => p.id !== state.myId).map((p) => p.id));
    for (const [id, peer] of state.peers) {
      if (!ids.has(id)) {
        try { peer.pc.close(); } catch {}
        state.peers.delete(id);
        removeAudioFor(id);
      }
    }
    for (const id of ids) addPeer(id);
  }

  function addPeer(peerId) {
    const existing = state.peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: state.iceServers, bundlePolicy: 'max-bundle' });
    const peer = {
      pc,
      polite: state.myId < peerId,
      makingOffer: false,
      ignoreOffer: false,
      videoStream: null,
      stats: null,
      connState: pc.connectionState,
    };
    state.peers.set(peerId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) emitSignal(peerId, { candidate: e.candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        emitSignal(peerId, { description: pc.localDescription });
      } catch (err) {
        console.warn('negotiation failed:', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0];
      if (!stream) return;
      if (e.track.kind === 'video') {
        peer.videoStream = stream;
        e.track.addEventListener('ended', () => {
          if (peer.videoStream === stream) {
            peer.videoStream = null;
            renderRoom();
          }
        });
        e.track.addEventListener('unmute', () => renderRoom());
      } else {
        attachRemoteAudio(peerId, stream);
      }
      renderRoom();
    };

    pc.onconnectionstatechange = () => {
      peer.connState = pc.connectionState;
      if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch {}
      }
      if (pc.connectionState === 'connected') {
        reapplyVideoQuality(pc);
      }
      renderRoom();
    };

    // 對方中途加入時，把已開啟的本地媒體補加到這條新連線
    if (state.micTrack && state.micStream) pc.addTrack(state.micTrack, state.micStream);
    if (state.screenTrack && state.screenStream) {
      const sender = pc.addTrack(state.screenTrack, state.screenStream);
      applySenderQuality(sender);
    }

    return peer;
  }

  async function onSignal(from, data) {
    const peer = addPeer(from);
    const pc = peer.pc;

    if (data.description) {
      const offerCollision =
        data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      try {
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          emitSignal(from, { description: pc.localDescription });
        }
      } catch (err) {
        console.warn('description handling failed:', err);
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!peer.ignoreOffer) console.warn('ICE candidate error:', err);
      }
    }
  }

  function attachRemoteAudio(peerId, stream) {
    if (stream.getVideoTracks().length > 0) return; // 有畫面的串流由 tile 的 video 播放聲音
    const key = `${peerId}:${stream.id}`;
    if (audioEls.has(key)) return;
    const a = document.createElement('audio');
    a.autoplay = true;
    a.srcObject = stream;
    a.dataset.peer = peerId;
    $('#audios').appendChild(a);
    audioEls.set(key, a);
  }

  function removeAudioFor(peerId) {
    for (const [key, a] of audioEls) {
      if (a.dataset.peer === peerId) {
        a.srcObject = null;
        a.remove();
        audioEls.delete(key);
      }
    }
  }

  function closeAllPeers() {
    for (const [, peer] of state.peers) {
      try { peer.pc.close(); } catch {}
    }
    state.peers.clear();
  }

  /* ================= 麥克風 ================= */

  async function toggleMic() {
    if (!state.micStream) {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        return toast('無法存取麥克風：' + err.message, 'error');
      }
      state.micStream = stream;
      state.micTrack = stream.getAudioTracks()[0];
      state.micMuted = false;
      for (const [, peer] of state.peers) peer.pc.addTrack(state.micTrack, stream);
      emitState();
      updateControlBar();
      toast('麥克風已開啟', 'success');
    } else {
      stopMic();
      toast('麥克風已關閉');
    }
  }

  function stopMic() {
    if (!state.micStream) return;
    for (const [, peer] of state.peers) {
      const sender = peer.pc.getSenders().find((s) => s.track === state.micTrack);
      if (sender) {
        try { peer.pc.removeTrack(sender); } catch {}
      }
    }
    state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
    state.micTrack = null;
    state.micMuted = false;
    emitState();
    updateControlBar();
  }

  function toggleMute() {
    if (!state.micTrack) return;
    state.micMuted = !state.micMuted;
    state.micTrack.enabled = !state.micMuted;
    emitState();
    updateControlBar();
  }

  /* ================= 螢幕分享（1080p／最高 120fps）================= */

  async function toggleScreen() {
    if (state.screenStream) return stopScreenShare();

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraintsFor(state.quality),
        audio: true, // 盡量一併擷取系統／分頁聲音
      });
    } catch (err) {
      return toast('無法擷取螢幕：' + (err.message || '已取消'), 'error');
    }

    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      return toast('沒有取得畫面軌道', 'error');
    }

    state.screenStream = stream;
    state.screenTrack = track;
    track.contentHint = state.quality === 'text' ? 'detail' : 'motion';
    track.addEventListener('ended', () => stopScreenShare()); // 使用者按瀏覽器的「停止分享」

    for (const [, peer] of state.peers) {
      const sender = peer.pc.addTrack(track, stream);
      await applySenderQuality(sender);
    }

    emitState();
    updateControlBar();
    renderRoom();

    const s = track.getSettings();
    const fps = s.frameRate ? Math.round(s.frameRate) : null;
    toast(
      `開始分享（擷取 ${s.width || '?'}×${s.height || '?'} @ ${fps ?? '—'}fps）` +
        (state.quality === 'ultra' && fps !== null && fps < 120 ? '\n⚠️ 目前低於 120fps 目標' : ''),
      fps !== null && fps < 120 ? 'info' : 'success'
    );
  }

  async function stopScreenShare() {
    const stream = state.screenStream;
    if (!stream) return;
    state.screenStream = null;
    state.screenTrack = null;
    stream.getTracks().forEach((t) => t.stop());
    for (const [, peer] of state.peers) {
      const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        try { peer.pc.removeTrack(sender); } catch {}
      }
    }
    emitState();
    updateControlBar();
    renderRoom();
  }

  async function onQualityChange() {
    state.quality = $('#quality').value;
    if (!state.screenTrack) return;
    state.screenTrack.contentHint = state.quality === 'text' ? 'detail' : 'motion';
    try {
      await state.screenTrack.applyConstraints(videoConstraintsFor(state.quality));
    } catch (err) {
      console.warn('applyConstraints failed:', err);
    }
    for (const [, peer] of state.peers) {
      const sender = peer.pc.getSenders().find((s) => s.track === state.screenTrack);
      if (sender) await applySenderQuality(sender);
    }
    toast('畫質設定已套用');
  }

  /* ================= 即時統計（解析度／幀率量測）================= */

  function startStats() {
    if (!state.statsTimer) state.statsTimer = setInterval(pollStats, 1000);
  }

  function stopStats() {
    clearInterval(state.statsTimer);
    state.statsTimer = null;
  }

  async function pollStats() {
    if (!state.room) return;
    for (const [id, peer] of state.peers) {
      if (!peer.videoStream) {
        peer.stats = null;
        continue;
      }
      try {
        const stats = await peer.pc.getStats();
        let best = null;
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video' && r.frameWidth) {
            if (!best || (r.framesPerSecond || 0) > (best.framesPerSecond || 0)) best = r;
          }
        });
        peer.stats = best
          ? {
              w: best.frameWidth,
              h: best.frameHeight,
              fps: best.framesPerSecond ? Math.round(best.framesPerSecond) : null,
            }
          : null;
      } catch {
        peer.stats = null;
      }
    }
    updateStatsBadges();
  }

  function updateStatsBadges() {
    for (const [id, tile] of tileEls) {
      let text = '';
      let warn = false;
      if (id === state.myId) {
        if (state.screenTrack && state.screenTrack.getSettings) {
          const s = state.screenTrack.getSettings();
          const fps = s.frameRate ? Math.round(s.frameRate) : null;
          text = `擷取 ${s.width || '?'}×${s.height || '?'} @ ${fps ?? '—'} fps`;
          warn = state.quality === 'ultra' && fps !== null && fps < 120;
        }
      } else {
        const st = state.peers.get(id)?.stats;
        if (st) {
          text = `${st.w}×${st.h} @ ${st.fps ?? '—'} fps`;
          warn = state.quality === 'ultra' && st.fps !== null && st.fps < 120;
        }
      }
      tile.statsEl.textContent = text;
      tile.statsEl.classList.toggle('hidden', !text);
      tile.statsEl.classList.toggle('warn', warn);
    }
  }

  /* ================= 房間畫面渲染 ================= */

  function toggleFullscreen(node) {
    const doc = document;
    const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement;
    if (fsEl) {
      const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
      if (exit) exit.call(doc);
      return;
    }
    const req = node.requestFullscreen || node.webkitRequestFullscreen;
    if (!req) return toast('此瀏覽器不支援全螢幕', 'error');
    try {
      const r = req.call(node);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {}
  }

  function ensureTile(p) {
    let t = tileEls.get(p.id);
    if (t) return t;

    const root = el('div', 'tile');
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = p.id === state.myId; // 自己的預覽靜音避免回音
    video.addEventListener('click', () => {
      if (video.paused) video.play().catch(() => {});
    });
    video.addEventListener('dblclick', () => toggleFullscreen(root));

    const avatar = el('div', 'tile-avatar');
    const avatarCircle = el('div', 'avatar-circle');
    avatar.appendChild(avatarCircle);
    const waiting = el('div', 'tile-waiting hidden', '等待畫面…');

    const top = el('div', 'tile-top');
    const badgeOwner = el('span', 'badge badge-owner hidden', '👑 房主');
    const topRight = el('div', 'tile-top-right');
    const statsEl = el('span', 'badge badge-stats hidden');
    const fsBtn = el('button', 'btn-fs', '⛶');
    fsBtn.title = '全螢幕（或雙擊畫面）';
    fsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen(root);
    });
    topRight.append(statsEl, fsBtn);
    top.append(badgeOwner, topRight);

    const bottom = el('div', 'tile-bottom');
    const nameRow = el('div', 'tile-namerow');
    const badgeMic = el('span', 'tile-ico hidden', '🎤');
    const badgeScreen = el('span', 'tile-ico hidden', '🖥️');
    const nameEl = el('span', 'tile-name');
    nameRow.append(nameEl, badgeMic, badgeScreen);
    const stateEl = el('span', 'tile-state');
    bottom.append(nameRow, stateEl);

    root.append(video, avatar, waiting, top, bottom);
    $('#tiles').appendChild(root);

    t = { root, video, avatarCircle, waitingEl: waiting, badgeOwner, badgeMic, badgeScreen, nameEl, stateEl, statsEl, attached: null };
    tileEls.set(p.id, t);
    return t;
  }

  function renderRoom() {
    if (!state.room) return;

    $('#room-name').textContent = state.room.name;
    $('#room-code').textContent = state.room.code;
    const me = state.participants.find((p) => p.id === state.myId) || {};
    const isOwner = !!me.isOwner;
    $('#owner-badge').classList.toggle('hidden', !isOwner);
    $('#btn-settings').classList.toggle('hidden', !isOwner);
    $('#participant-count').textContent = `${state.participants.length} 人在房間`;

    const ordered = [...state.participants].sort((a, b) => Number(b.screenOn) - Number(a.screenOn));
    const seen = new Set();

    for (const p of ordered) {
      seen.add(p.id);
      const tile = ensureTile(p);
      const isSelf = p.id === state.myId;
      const peer = state.peers.get(p.id);

      tile.nameEl.textContent = p.name + (isSelf ? '（我）' : '');
      tile.badgeOwner.classList.toggle('hidden', !p.isOwner);
      tile.badgeMic.classList.toggle('hidden', !(p.micOn && p.micMuted));
      tile.badgeScreen.classList.toggle('hidden', !p.screenOn);

      const stream = isSelf ? state.screenStream : (peer && peer.videoStream) || null;
      const hasVideo = !!(stream && stream.getVideoTracks().some((tr) => tr.readyState === 'live'));

      if (hasVideo) {
        if (tile.attached !== stream) {
          tile.video.srcObject = stream;
          tile.attached = stream;
        }
        tile.video.classList.remove('hidden');
        tile.video.play().catch(() => {});
      } else {
        if (tile.attached) {
          tile.video.srcObject = null;
          tile.attached = null;
        }
        tile.video.classList.add('hidden');
      }

      tile.waitingEl.classList.toggle('hidden', !(p.screenOn && !hasVideo));
      tile.root.classList.toggle('has-video', hasVideo);

      // 依名字決定頭像色調，停止分享後的畫面也比好看得出誰是誰
      const initial = (p.name || '?').charAt(0).toUpperCase();
      const hue = [...p.name].reduce((a, c) => a + c.codePointAt(0), 0) % 360;
      tile.avatarCircle.textContent = initial;
      tile.avatarCircle.style.setProperty('--h', hue);

      const label = isSelf ? '' : connLabel(peer);
      tile.stateEl.textContent = label;
      tile.stateEl.classList.toggle('bad', label === '連線失敗');
    }

    for (const [id, tile] of tileEls) {
      if (!seen.has(id)) {
        tile.root.remove();
        tileEls.delete(id);
      }
    }

    updateStatsBadges();
  }

  function clearTiles() {
    for (const [, tile] of tileEls) tile.root.remove();
    tileEls.clear();
    for (const [, a] of audioEls) {
      a.srcObject = null;
      a.remove();
    }
    audioEls.clear();
  }

  /* ================= 控制列狀態 ================= */

  function emitState() {
    state.socket.emit('media:state', {
      micOn: !!state.micStream,
      micMuted: state.micMuted,
      screenOn: !!state.screenStream,
    });
  }

  function updateControlBar() {
    const mic = $('#btn-mic');
    mic.textContent = state.micStream ? '🎤 關閉麥克風' : '🎤 開啟麥克風';
    mic.classList.toggle('active', !!state.micStream);

    const mute = $('#btn-mute');
    mute.disabled = !state.micStream;
    mute.textContent = state.micMuted ? '🔇 取消靜音' : '🔇 靜音';
    mute.classList.toggle('active', state.micMuted);

    const screen = $('#btn-screen');
    screen.textContent = state.screenStream ? '🖥️ 停止分享' : '🖥️ 分享螢幕';
    screen.classList.toggle('active', !!state.screenStream);
  }

  /* ================= 進出房間 ================= */

  function showView(inRoom) {
    $('#view-lobby').classList.toggle('hidden', inRoom);
    $('#view-room').classList.toggle('hidden', !inRoom);
  }

  function enterRoom(res) {
    state.myId = res.self;
    state.room = res.room;
    state.participants = Array.isArray(res.participants) ? res.participants : [];
    showView(true);
    renderRoom();
    updateControlBar();
    startStats();
  }

  async function leaveRoomUI() {
    if (!state.room) return;
    stopStats();
    stopMic();
    await stopScreenShare();
    closeAllPeers();
    clearTiles();
    try { await ack('room:leave', {}); } catch {}
    state.room = null;
    state.myId = null;
    state.participants = [];
    showView(false);
    refreshRoomList();
  }

  /* ================= 大廳 ================= */

  async function refreshRoomList() {
    try {
      const res = await fetch('/api/rooms');
      const list = await res.json();
      const box = $('#room-list');
      if (!Array.isArray(list) || list.length === 0) {
        box.textContent = '';
        box.appendChild(el('p', 'muted', '現在沒有開放的房間，成為第一位房主吧！'));
        return;
      }
      box.textContent = '';
      for (const room of list) {
        const item = el('div', 'room-item');
        const info = el('div');
        info.appendChild(el('div', 'room-item-name', room.name));
        info.appendChild(el('div', 'room-item-sub', `房間碼 ${room.code} · ${room.participants} 人在房`));
        const btn = el('button', 'ghost', '加入');
        btn.addEventListener('click', () => {
          $('#join-code').value = room.code;
          $('#join-password').focus();
        });
        item.append(info, btn);
        box.appendChild(item);
      }
    } catch {}
  }

  async function createRoom() {
    const nickname = $('#nickname').value.trim();
    const name = $('#create-name').value.trim();
    const password = $('#create-password').value;
    if (!nickname) return toast('請先填寫暱稱', 'error');
    if (!name) return toast('請填寫房間名稱', 'error');
    if (!password) return toast('請設定房間密碼', 'error');

    $('#btn-create').disabled = true;
    const res = await ack('room:create', { name, password, nickname });
    $('#btn-create').disabled = false;
    if (!res.ok) return toast(res.error, 'error');
    enterRoom(res);
    toast(`房間建立成功！房間碼：${res.room.code}`, 'success');
  }

  async function joinRoom() {
    const nickname = $('#nickname').value.trim();
    const code = $('#join-code').value.trim().toUpperCase();
    const password = $('#join-password').value;
    if (!nickname) return toast('請先填寫暱稱', 'error');
    if (!code) return toast('請填寫房間碼', 'error');
    if (!password) return toast('請填寫房間密碼', 'error');

    $('#btn-join').disabled = true;
    const res = await ack('room:join', { code, password, nickname });
    $('#btn-join').disabled = false;
    if (!res.ok) return toast(res.error, 'error');
    enterRoom(res);
    toast(`已加入「${res.room.name}」`, 'success');
  }

  /* ================= 房主設定 ================= */

  function openSettings() {
    $('#set-name').value = state.room.name;
    $('#set-password').value = '';
    $('#modal-settings').classList.remove('hidden');
  }

  function closeSettings() {
    $('#modal-settings').classList.add('hidden');
  }

  async function saveSettings() {
    const name = $('#set-name').value.trim();
    const password = $('#set-password').value;
    state.updatingRoom = true;
    const res = await ack('room:update', { name, password: password || undefined });
    state.updatingRoom = false;
    if (!res.ok) return toast(res.error, 'error');
    closeSettings();
    toast('房間設定已更新', 'success');
  }

  /* ================= 啟動 ================= */

  function bindUI() {
    $('#btn-create').addEventListener('click', createRoom);
    $('#btn-join').addEventListener('click', joinRoom);
    $('#btn-leave').addEventListener('click', leaveRoomUI);
    $('#btn-mic').addEventListener('click', toggleMic);
    $('#btn-mute').addEventListener('click', toggleMute);
    $('#btn-screen').addEventListener('click', toggleScreen);
    $('#quality').addEventListener('change', onQualityChange);
    $('#btn-copy-code').addEventListener('click', async () => {
      if (!state.room) return;
      try {
        await navigator.clipboard.writeText(state.room.code);
        toast('已複製房間碼', 'success');
      } catch {
        toast('複製失敗，房間碼：' + state.room.code, 'error');
      }
    });

    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-settings-cancel').addEventListener('click', closeSettings);
    $('#btn-settings-save').addEventListener('click', saveSettings);
    $('#modal-settings').addEventListener('click', (e) => {
      if (e.target === $('#modal-settings')) closeSettings();
    });

    for (const id of ['create-name', 'create-password']) {
      $('#' + id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') createRoom();
      });
    }
    for (const id of ['join-code', 'join-password']) {
      $('#' + id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinRoom();
      });
    }

    window.addEventListener('beforeunload', () => {
      if (state.room) state.socket.emit('room:leave');
    });

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      const btn = $('#btn-screen');
      btn.disabled = true;
      btn.title = '此瀏覽器不支援螢幕分享（需要桌面版 Chrome／Edge）';
    }
  }

  async function boot() {
    try {
      const res = await fetch('/api/ice');
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length) state.iceServers = data.iceServers;
    } catch {}

    state.socket = io();
    bindSocket();
    bindUI();
    refreshRoomList();
    setInterval(() => {
      if (!state.room) refreshRoomList();
    }, 4000);
  }

  boot();
})();
