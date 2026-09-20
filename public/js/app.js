/* Room — 私密語音・螢幕分享房間
 * 靜態版：PeerJS 雲端信令 + WebRTC mesh，無需後端，可直接部署 GitHub Pages
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const ROOM_PREFIX = 'gh-room-'; // PeerJS peer ID 前綴，避免與其他 PeerJS 用戶碰撞
  const MAX_PARTICIPANTS = 8;
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I/O/0/1
  const STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const state = {
    peer: null,
    myId: null,
    room: null,            // { code, name }
    roomPassword: null,
    isHost: false,
    nickname: '',
    participants: [],     // [{ id, name, micOn, micMuted, screenOn, isOwner }]
    dataConns: new Map(), // peerId -> DataConnection
    peers: new Map(),     // peerId -> { pc, polite, makingOffer, ignoreOffer, videoStream, stats, connState }
    micStream: null,
    micTrack: null,
    micMuted: false,
    screenStream: null,
    screenTrack: null,
    quality: 'ultra',
    statsTimer: null,
    updatingRoom: false,
    iceServers: STUN_SERVERS,
  };

  const tileEls = new Map();
  const audioEls = new Map();

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

  function connLabel(peer) {
    if (!peer) return '';
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

  function makeRoomCode() {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return code;
  }

  function setBadge(text, cls) {
    const b = document.querySelector('#conn-badge');
    if (b) {
      b.textContent = text;
      b.className = 'conn-badge' + (cls ? ' ' + cls : '');
    }
  }

  /* ================= 畫質設定 ================= */

  function videoConstraintsFor(q) {
    if (q === 'text') return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } };
    if (q === 'saver') return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 120, max: 120 } };
  }

  function bitrateFor(q) {
    return q === 'ultra' ? 16_000_000 : q === 'text' ? 8_000_000 : 3_500_000;
  }

  function degradationFor(q) {
    if (q === 'text') return 'maintain-resolution';
    if (q === 'saver') return 'balanced';
    return 'maintain-framerate';
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

  function reapplyVideoQuality(pc) {
    for (const s of pc.getSenders()) {
      if (s.track && s.track.kind === 'video') applySenderQuality(s);
    }
  }

  /* ================= PeerJS 信令層（取代 Socket.IO）================= */

  function sendTo(peerId, msg) {
    const conn = state.dataConns.get(peerId);
    if (conn && conn.open) {
      conn.send(msg);
      return true;
    }
    return false;
  }

  function broadcast(msg) {
    for (const [, conn] of state.dataConns) {
      if (conn.open) conn.send(msg);
    }
  }

  function setupDataConn(conn) {
    if (state.dataConns.has(conn.peer) && state.dataConns.get(conn.peer) !== conn) {
      // 已有連線，關閉重複的
      try { conn.close(); } catch {}
      return;
    }
    state.dataConns.set(conn.peer, conn);

    conn.on('data', (msg) => {
      handleDataMessage(conn.peer, msg);
    });

    conn.on('close', () => {
      onPeerDisconnect(conn.peer);
    });

    conn.on('error', (err) => {
      console.warn('Data connection error:', err);
    });
  }

  function handleDataMessage(fromPeerId, msg) {
    switch (msg.type) {
      case 'signal':
        onSignal(fromPeerId, msg.data).catch((err) => console.warn('signal error:', err));
        break;

      case 'media:state': {
        const p = state.participants.find((p) => p.id === fromPeerId);
        if (p) {
          if (typeof msg.micOn === 'boolean') p.micOn = msg.micOn;
          if (typeof msg.micMuted === 'boolean') p.micMuted = msg.micMuted;
          if (typeof msg.screenOn === 'boolean') p.screenOn = msg.screenOn;
          renderRoom();
        }
        break;
      }

      case 'participants':
        state.participants = msg.participants;
        syncPeers(msg.participants);
        renderRoom();
        break;

      case 'room:updated':
        if (state.room) state.room = { ...state.room, name: msg.name };
        if (msg.participants) {
          state.participants = msg.participants;
          syncPeers(msg.participants);
        }
        if (!state.updatingRoom) {
          if (msg.renamed) toast(`房主已將房間名稱改為「${msg.name}」`);
          if (msg.passwordChanged) toast('房主已更新房間密碼');
        }
        renderRoom();
        break;

      case 'room:closed':
        toast('房主已關閉房間', 'error');
        leaveRoomUI(true);
        break;

      case 'hello': {
        const existing = state.participants.find((p) => p.id === fromPeerId);
        if (!existing) {
          state.participants.push({
            id: fromPeerId,
            name: msg.name || '未知',
            micOn: !!msg.micOn,
            micMuted: !!msg.micMuted,
            screenOn: !!msg.screenOn,
            isOwner: false,
          });
          syncPeers(state.participants);
          renderRoom();
          if (msg.name) toast(`${msg.name} 加入了房間`, 'success');
        } else if (msg.name && existing.name !== msg.name) {
          existing.name = msg.name;
          renderRoom();
        }
        break;
      }

      case 'auth-ok':
      case 'auth-fail':
        // 由 joinRoom 內部直接處理
        break;
    }
  }

  function onPeerDisconnect(peerId) {
    state.dataConns.delete(peerId);

    const peer = state.peers.get(peerId);
    if (peer) {
      try { peer.pc.close(); } catch {}
      state.peers.delete(peerId);
      removeAudioFor(peerId);
    }

    const p = state.participants.find((p) => p.id === peerId);
    state.participants = state.participants.filter((p) => p.id !== peerId);

    const tile = tileEls.get(peerId);
    if (tile) {
      tile.root.remove();
      tileEls.delete(peerId);
    }

    if (p && state.room) {
      toast(`${p.name} 離開了房間`);
    }

    // 房主離開時，通知所有人並關閉房間
    if (p && p.isOwner && !state.isHost) {
      toast('房主已離開，房間已關閉', 'error');
      leaveRoomUI(true);
      return;
    }

    // 如果是房主，通知所有人
    if (p && state.isHost) {
      broadcast({ type: 'participants', participants: state.participants });
    }

    renderRoom();
  }

  function connectToPeer(peerId) {
    if (state.dataConns.has(peerId)) return;
    if (!state.peer || !state.peer.open) return;

    const conn = state.peer.connect(peerId, { serialization: 'json', reliable: true });
    conn.on('open', () => {
      setupDataConn(conn);
      conn.send({
        type: 'hello',
        name: state.nickname,
        micOn: !!state.micStream,
        micMuted: state.micMuted,
        screenOn: !!state.screenStream,
      });
    });
    conn.on('error', (err) => {
      console.warn('Failed to connect to peer:', err);
    });
  }

  /* ================= WebRTC（perfect negotiation）================= */

  function emitSignal(to, data) {
    // 確保 RTC 物件可序列化
    const plain = {};
    if (data.description) {
      plain.description = { type: data.description.type, sdp: data.description.sdp };
    }
    if (data.candidate) {
      plain.candidate = {
        candidate: data.candidate.candidate,
        sdpMid: data.candidate.sdpMid,
        sdpMLineIndex: data.candidate.sdpMLineIndex,
        usernameFragment: data.candidate.usernameFragment,
      };
    }
    sendTo(to, { type: 'signal', data: plain });
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
    for (const id of ids) {
      addPeer(id);
      // 確保 data connection 存在：ID 較小的一方發起連線，避免重複
      if (!state.dataConns.has(id) && state.myId < id) {
        connectToPeer(id);
      }
    }
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
    if (stream.getVideoTracks().length > 0) return;
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
        audio: true,
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
    track.addEventListener('ended', () => stopScreenShare());

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
      `開始分享（擷取 ${s.width || '?'}x${s.height || '?'} @ ${fps ?? '—'}fps）` +
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

  /* ================= 即時統計 ================= */

  function startStats() {
    if (!state.statsTimer) state.statsTimer = setInterval(pollStats, 1000);
  }

  function stopStats() {
    clearInterval(state.statsTimer);
    state.statsTimer = null;
  }

  async function pollStats() {
    if (!state.room) return;
    for (const [, peer] of state.peers) {
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
          ? { w: best.frameWidth, h: best.frameHeight, fps: best.framesPerSecond ? Math.round(best.framesPerSecond) : null }
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
          text = `擷取 ${s.width || '?'}x${s.height || '?'} @ ${fps ?? '—'} fps`;
          warn = state.quality === 'ultra' && fps !== null && fps < 120;
        }
      } else {
        const st = state.peers.get(id)?.stats;
        if (st) {
          text = `${st.w}x${st.h} @ ${st.fps ?? '—'} fps`;
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
    video.muted = p.id === state.myId;
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

  /* ================= 控制列 ================= */

  function emitState() {
    broadcast({
      type: 'media:state',
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

  async function leaveRoomUI(silent = false) {
    if (!state.room) return;
    stopStats();
    stopMic();
    await stopScreenShare();
    closeAllPeers();
    clearTiles();

    // 關閉所有 data connections
    for (const [, conn] of state.dataConns) {
      try { conn.close(); } catch {}
    }
    state.dataConns.clear();

    // 房主離開時通知所有人
    if (state.isHost && !silent) {
      broadcast({ type: 'room:closed' });
    }

    // 銷毀 PeerJS 實例
    if (state.peer) {
      try { state.peer.destroy(); } catch {}
      state.peer = null;
    }

    state.room = null;
    state.myId = null;
    state.participants = [];
    state.isHost = false;
    state.roomPassword = null;
    setBadge('就緒', 'on');
    showView(false);
  }

  /* ================= 大廳：建房 / 加入 ================= */

  async function createRoom() {
    const nickname = $('#nickname').value.trim();
    const name = $('#create-name').value.trim();
    const password = $('#create-password').value;
    if (!nickname) return toast('請先填寫暱稱', 'error');
    if (!name) return toast('請填寫房間名稱', 'error');
    if (!password || password.length < 4) return toast('請設定至少 4 字的房間密碼', 'error');

    $('#btn-create').disabled = true;
    setBadge('連線中…', '');

    const code = makeRoomCode();
    const peerId = `${ROOM_PREFIX}${code}`;

    const peer = new Peer(peerId, {
      config: { iceServers: state.iceServers },
      debug: 1,
    });

    state.peer = peer;
    state.nickname = nickname;
    state.isHost = true;

    peer.on('open', (id) => {
      state.myId = id;
      state.room = { code, name };
      state.roomPassword = password;
      state.participants = [{
        id, name: nickname, micOn: false, micMuted: false, screenOn: false, isOwner: true,
      }];
      setBadge('🟢 已連線', 'on');

      // 房主接收加入者的 data connection
      peer.on('connection', (conn) => {
        let authenticated = false;

        conn.on('data', (msg) => {
          if (msg.type === 'auth' && !authenticated) {
            if (msg.password !== state.roomPassword) {
              conn.send({ type: 'auth-fail', error: '密碼錯誤' });
              setTimeout(() => { try { conn.close(); } catch {} }, 500);
              return;
            }
            if (state.participants.length >= MAX_PARTICIPANTS) {
              conn.send({ type: 'auth-fail', error: `房間已滿（上限 ${MAX_PARTICIPANTS} 人）` });
              setTimeout(() => { try { conn.close(); } catch {} }, 500);
              return;
            }

            authenticated = true;
            state.participants.push({
              id: conn.peer, name: msg.nickname, micOn: false, micMuted: false, screenOn: false, isOwner: false,
            });
            setupDataConn(conn);

            // 回傳參與者列表
            conn.send({
              type: 'auth-ok',
              self: conn.peer,
              room: state.room,
              participants: state.participants,
            });

            // 通知所有人更新列表
            broadcast({ type: 'participants', participants: state.participants });
            toast(`${msg.nickname} 加入了房間`, 'success');
          } else if (authenticated) {
            handleDataMessage(conn.peer, msg);
          }
        });

        conn.on('close', () => {
          if (authenticated) onPeerDisconnect(conn.peer);
        });

        conn.on('error', (err) => {
          console.warn('Host conn error:', err);
        });
      });

      // 房主也接收 incoming WebRTC media calls（由 ontrack 處理，不需額外 handler）
      peer.on('call', (call) => {
        const stream = state.micStream || new MediaStream();
        call.answer(stream);
      });

      enterRoom({ self: id, room: state.room, participants: state.participants });
      toast(`房間建立成功！房間碼：${code}`, 'success');
    });

    peer.on('error', (err) => {
      $('#btn-create').disabled = false;
      if (err.type === 'unavailable-id') {
        // 房間碼碰撞，自動重試
        try { peer.destroy(); } catch {}
        state.peer = null;
        return createRoom();
      }
      setBadge('🔴 連線錯誤', 'off');
      toast('連線錯誤：' + err.type, 'error');
      try { peer.destroy(); } catch {}
      state.peer = null;
    });
  }

  async function joinRoom() {
    const nickname = $('#nickname').value.trim();
    const code = $('#join-code').value.trim().toUpperCase();
    const password = $('#join-password').value;
    if (!nickname) return toast('請先填寫暱稱', 'error');
    if (!code) return toast('請填寫房間碼', 'error');
    if (!password) return toast('請填寫房間密碼', 'error');

    $('#btn-join').disabled = true;
    setBadge('連線中…', '');

    const peer = new Peer({ config: { iceServers: state.iceServers }, debug: 1 });
    state.peer = peer;
    state.nickname = nickname;
    state.isHost = false;

    let authTimer = null;

    peer.on('open', (id) => {
      state.myId = id;
      const hostId = `${ROOM_PREFIX}${code}`;
      const conn = peer.connect(hostId, { serialization: 'json', reliable: true });

      authTimer = setTimeout(() => {
        toast('連線逾時：找不到房間，請確認房間碼正確', 'error');
        $('#btn-join').disabled = false;
        setBadge('就緒', 'on');
        try { peer.destroy(); } catch {}
        state.peer = null;
      }, 10000);

      conn.on('open', () => {
        conn.send({ type: 'auth', password, nickname });
      });

      conn.on('data', (msg) => {
        if (msg.type === 'auth-ok') {
          clearTimeout(authTimer);
          state.room = msg.room;
          state.roomPassword = password;
          state.participants = msg.participants;
          setupDataConn(conn);
          setBadge('🟢 已連線', 'on');

          // 連接到其他所有參與者（非房主、非自己）
          const others = msg.participants.filter(
            (p) => p.id !== state.myId && p.id !== conn.peer
          );
          for (const p of others) {
            connectToPeer(p.id);
          }

          // 接收其他人的主動連線
          peer.on('connection', (pconn) => {
            if (!state.dataConns.has(pconn.peer)) {
              pconn.on('open', () => {
                setupDataConn(pconn);
                pconn.send({
                  type: 'hello',
                  name: state.nickname,
                  micOn: !!state.micStream,
                  micMuted: state.micMuted,
                  screenOn: !!state.screenStream,
                });
              });
            }
          });

          // 接收 incoming media calls
          peer.on('call', (call) => {
            const stream = state.micStream || new MediaStream();
            call.answer(stream);
          });

          enterRoom(msg);
          toast(`已加入「${msg.room.name}」`, 'success');
        } else if (msg.type === 'auth-fail') {
          clearTimeout(authTimer);
          toast(msg.error, 'error');
          $('#btn-join').disabled = false;
          setBadge('就緒', 'on');
          try { peer.destroy(); } catch {}
          state.peer = null;
        }
      });

      conn.on('error', (err) => {
        clearTimeout(authTimer);
        toast('連線錯誤：' + (err.message || '找不到房間'), 'error');
        $('#btn-join').disabled = false;
        setBadge('就緒', 'on');
        try { peer.destroy(); } catch {}
        state.peer = null;
      });
    });

    peer.on('error', (err) => {
      if (authTimer) clearTimeout(authTimer);
      $('#btn-join').disabled = false;
      if (err.type === 'peer-unavailable') {
        toast('找不到這個房間碼，請向房主確認', 'error');
      } else {
        toast('連線錯誤：' + err.type, 'error');
      }
      setBadge('🔴 連線錯誤', 'off');
      try { peer.destroy(); } catch {}
      state.peer = null;
    });
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
    if (!name) return toast('房間名稱不可空白', 'error');

    state.updatingRoom = true;

    const renamed = name !== state.room.name;
    const passwordChanged = !!password;

    state.room = { ...state.room, name };
    if (password) state.roomPassword = password;

    broadcast({
      type: 'room:updated',
      name,
      renamed,
      passwordChanged,
      participants: state.participants,
    });

    state.updatingRoom = false;
    closeSettings();
    toast('房間設定已更新', 'success');
    renderRoom();
  }

  /* ================= UI 綁定 ================= */

  function bindUI() {
    $('#btn-create').addEventListener('click', createRoom);
    $('#btn-join').addEventListener('click', joinRoom);
    $('#btn-leave').addEventListener('click', () => leaveRoomUI(false));
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
      if (state.isHost && state.room) {
        broadcast({ type: 'room:closed' });
      }
    });

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      const btn = $('#btn-screen');
      btn.disabled = true;
      btn.title = '此瀏覽器不支援螢幕分享（需要桌面版 Chrome／Edge）';
    }
  }

  /* ================= 啟動 ================= */

  function boot() {
    bindUI();

    // 靜態版無房間列表，改為提示
    const box = $('#room-list');
    if (box) {
      box.textContent = '';
      box.appendChild(
        el('p', 'muted', '靜態版無法顯示房間列表。請直接輸入房間碼加入，或建立新房間。')
      );
    }

    setBadge('就緒', 'on');
  }

  boot();
})();
