/* Room — 私密語音・螢幕分享房間
 * 靜態版：PeerJS 雲端信令 + WebRTC mesh，無需後端，可直接部署 GitHub Pages
 *
 * 房間生命週期（房間只住在房主的瀏覽器分頁）：
 * - 房主分頁開著 → 房間持續存在，任何人可用「房間碼＋密碼」中途加入
 * - 房主重新整理頁面 → 自動以同一組房間碼恢復房間；成員端會自動重連，房間不中斷
 * - 房主主動按「離開」→ 廣播關房，所有人退出
 * - 房主直接關閉分頁 → 成員端重連 90 秒，超過才判定房間關閉
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const ROOM_PREFIX = 'gh-room-'; // PeerJS peer ID 前綴，避免與其他 PeerJS 用戶碰撞
  const MAX_PARTICIPANTS = 8;
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I/O/0/1
  const HOST_RECONNECT_WINDOW_MS = 90_000;  // 房主斷線後，成員持續嘗試重連的時間
  const BOOT_RESTORE_WINDOW_MS = 30_000;    // 頁面重新整理後，自動重新加入的嘗試時間
  const RECONNECT_INTERVAL_MS = 3_000;      // 重連嘗試間隔
  const JOIN_ATTEMPT_TIMEOUT_MS = 10_000;   // 單次加入嘗試的逾時
  const AUTH_ATTEMPT_LIMIT = 5;             // 同一 peer 密碼錯誤次數上限（防暴力嘗試）

  // STUN 用於 NAT 穿透；公開 TURN 作為無法直連時的備援（媒體仍是點對點 DTLS-SRTP 加密，TURN 只轉發密文）
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
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
  };

  // 房主端：記錄每個 peer 密碼錯誤次數
  const authFails = new Map();
  // 成員端：房主斷線後的自動重連狀態
  const reconnect = { timer: null, active: false, attempting: false };

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

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

  /* ================= 本機狀態（讓房間在頁面重整後延續）================= */

  const HOST_STATE_KEY = 'room.hostState';   // { code, name, password, nickname }
  const CLIENT_STATE_KEY = 'room.clientState'; // { code, password, nickname }

  function saveHostState(creds) {
    try { sessionStorage.setItem(HOST_STATE_KEY, JSON.stringify(creds)); } catch {}
  }

  function saveClientState(creds) {
    try { sessionStorage.setItem(CLIENT_STATE_KEY, JSON.stringify(creds)); } catch {}
  }

  function readStored(key) {
    try {
      const v = JSON.parse(sessionStorage.getItem(key));
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  }

  function clearStoredState() {
    try {
      sessionStorage.removeItem(HOST_STATE_KEY);
      sessionStorage.removeItem(CLIENT_STATE_KEY);
    } catch {}
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

  /* ================= PeerJS 連線層 ================= */

  // 預設用 PeerJS 公開雲端；可用網址參數指定自架伺服器：?peerhost=x&peerport=9000&peerpath=/&pesecure=0
  function peerOptions() {
    const opts = { config: { iceServers: ICE_SERVERS }, debug: 1 };
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('peerhost')) {
        opts.host = q.get('peerhost');
        opts.port = Number(q.get('peerport') || 443);
        opts.path = q.get('peerpath') || '/';
        opts.secure = q.get('pesecure') === '1' || location.protocol === 'https:';
      }
    } catch {}
    return opts;
  }

  function destroyPeer() {
    if (state.peer) {
      try { state.peer.destroy(); } catch {}
      state.peer = null;
    }
  }

  // PeerJS 與信號伺服器的 socket 短暫斷線時自動重連（不影響已建立的 P2P 連線，
  // 但會影響「新房間碼可否被找到」，所以必須盡快恢復註冊）
  function attachKeepalive(peer) {
    peer.on('disconnected', () => {
      if (peer.destroyed) return;
      const retry = () => { try { peer.reconnect(); } catch {} };
      retry();
      setTimeout(() => { if (!peer.open && !peer.destroyed) retry(); }, 3000);
    });
    peer.on('error', (err) => {
      if (!state.room) return;
      console.warn('peer error:', err && err.type);
      if (err && (err.type === 'network' || err.type === 'server-error')) {
        setBadge('🟡 信號不穩，重試中…', 'warn');
      }
    });
  }

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
        if (msg.passwordChanged && msg.newPassword) {
          // 廣播新密碼給已在房內的成員：他們已通過驗證，帶著新密碼才能在斷線後自動重連
          state.roomPassword = msg.newPassword;
          saveClientState({ nickname: state.nickname, code: state.room.code, password: msg.newPassword });
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

    // 房主的連線斷了：可能是重新整理或短暫斷線，先自動重連，超過時限才判定關房
    if (p && p.isOwner && !state.isHost) {
      beginHostReconnect();
      renderRoom();
      return;
    }

    // 如果是房主，通知所有人更新名單
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
      if (state.dataConns.has(peerId)) {
        try { conn.close(); } catch {}
        return;
      }
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

  // 成員端：接收其他成員的主動連線（ID 較小的一方發起，hello 互補名單）
  function registerClientIncoming(peer) {
    peer.on('connection', (pconn) => {
      pconn.on('open', () => {
        if (state.dataConns.has(pconn.peer)) {
          try { pconn.close(); } catch {}
          return;
        }
        setupDataConn(pconn);
        pconn.send({
          type: 'hello',
          name: state.nickname,
          micOn: !!state.micStream,
          micMuted: state.micMuted,
          screenOn: !!state.screenStream,
        });
      });
    });
  }

  /* ================= 加入流程（建房／加入共用底層）================= */

  // 跨嘗試追蹤未決的加入連線：新嘗試開始時清掉舊的，避免同一成員建立多條連線
  const pendingJoinConns = [];

  /**
   * 對房主 peer ID 建立資料連線並完成密碼驗證。
   * 成功 resolve({ conn, data })；失敗 reject(Error)，err.fatal 表示重試也沒用（密碼錯誤／房間已滿）。
   */
  function attemptJoin(creds) {
    return new Promise((resolve, reject) => {
      while (pendingJoinConns.length) {
        const c = pendingJoinConns.pop();
        try { c.close(); } catch {}
      }

      let peer = state.peer;
      if (!peer || peer.destroyed) {
        peer = new Peer(peerOptions());
        state.peer = peer;
        attachKeepalive(peer);
        registerClientIncoming(peer);
        peer.on('open', (id) => { state.myId = id; });
      }
      if (!peer.open) {
        try { peer.reconnect(); } catch {}
      }

      let done = false;
      let openTimer = null;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(openTimer);
        try { peer.off('error', onPeerError); } catch {}
        fn(arg);
      };
      const onPeerError = (err) => {
        const e = new Error(
          err && err.type === 'peer-unavailable' ? '找不到房間' : `連線錯誤：${(err && err.type) || 'unknown'}`
        );
        finish(reject, e);
      };
      peer.on('error', onPeerError);

      const onReady = () => {
        if (done) return;
        const hostId = ROOM_PREFIX + creds.code;
        const conn = peer.connect(hostId, { serialization: 'json', reliable: true });
        pendingJoinConns.push(conn);
        const onConnData = (msg) => {
          if (!msg || typeof msg.type !== 'string') return;
          if (msg.type === 'auth-ok') {
            finish(resolve, { conn, data: msg });
          } else if (msg.type === 'auth-fail') {
            const e = new Error(msg.error || '驗證失敗');
            e.fatal = true;
            finish(reject, e);
          }
        };
        conn.on('data', onConnData);
        conn.on('open', () => {
          if (done) {
            // 已有更新的嘗試勝出，這條遲到的連線直接關掉
            try { conn.close(); } catch {}
            return;
          }
          conn.send({ type: 'auth', password: creds.password, nickname: creds.nickname });
        });
        conn.on('error', (err) => finish(reject, new Error('連線錯誤：' + (err.message || 'unknown'))));
        conn.on('close', () => finish(reject, new Error('連線中斷')));
      };

      if (peer.open) {
        onReady();
        openTimer = setTimeout(() => finish(reject, new Error('連線逾時')), JOIN_ATTEMPT_TIMEOUT_MS);
      } else {
        peer.once('open', onReady);
        openTimer = setTimeout(() => finish(reject, new Error('連線逾時')), JOIN_ATTEMPT_TIMEOUT_MS);
      }
    });
  }

  /** 成員進房共用入口：建立狀態、同步名單與媒體連線。保留現有麥克風／螢幕分享。 */
  function acceptJoin(conn, data, creds) {
    const newId = data.self || (state.peer && state.peer.id) || state.myId;

    if (state.myId && newId !== state.myId) {
      // 斷線後換了新的 peer ID：舊的媒體／資料連線全部作廢，重建
      closeAllPeers();
      for (const [, c] of state.dataConns) {
        if (c !== conn) { try { c.close(); } catch {} }
      }
      state.dataConns.clear();
      clearTiles();
    }

    state.myId = newId;
    state.room = data.room;
    state.roomPassword = creds.password;
    state.nickname = creds.nickname;
    state.participants = Array.isArray(data.participants) ? data.participants : [];

    // 房主頁面重整後，指向房主的舊 RTCPeerConnection 已死（對方物件不存在了），
    // 不是 connected 就強制重建，否則 addPeer 會回傳舊的死連線，收不到房主的媒體
    const hostPc = state.peers.get(conn.peer);
    if (hostPc && hostPc.pc.connectionState !== 'connected') {
      try { hostPc.pc.close(); } catch {}
      state.peers.delete(conn.peer);
      removeAudioFor(conn.peer);
    }

    setupDataConn(conn);
    syncPeers(state.participants);

    if (!state.isHost) saveClientState(creds);
    setBadge('🟢 已連線', 'on');
    enterRoom();
  }

  function beginHostReconnect() {
    if (reconnect.active) return;
    const creds = {
      nickname: state.nickname,
      code: state.room && state.room.code,
      password: state.roomPassword,
    };
    if (!creds.code || !creds.password) return leaveRoomUI(true);
    saveClientState(creds);

    const deadline = Date.now() + HOST_RECONNECT_WINDOW_MS;
    reconnect.active = true;
    reconnect.attempting = false;
    toast(`與房主的連線中斷，${Math.round(HOST_RECONNECT_WINDOW_MS / 1000)} 秒內自動重連…`);

    reconnect.timer = setInterval(async () => {
      if (!reconnect.active) return;
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setBadge(`🟡 房主暫時離線，重連中（${left}s）…`, 'warn');
      if (Date.now() >= deadline) return hostReconnectFailed();
      if (reconnect.attempting) return;
      reconnect.attempting = true;
      try {
        const { conn, data } = await attemptJoin(creds);
        stopReconnect();
        reconnect.active = false;
        acceptJoin(conn, data, creds);
        toast('已重新連上房主', 'success');
      } catch (err) {
        reconnect.attempting = false;
        if (err.fatal) {
          toast('無法重連：' + err.message, 'error');
          hostReconnectFailed();
        }
        // 其他錯誤（房主還沒回來）等下一輪再試
      }
    }, RECONNECT_INTERVAL_MS);
  }

  function hostReconnectFailed() {
    stopReconnect();
    reconnect.active = false;
    toast('房主已離開，房間已關閉', 'error');
    leaveRoomUI(true);
  }

  function stopReconnect() {
    if (reconnect.timer) clearInterval(reconnect.timer);
    reconnect.timer = null;
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

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });
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
      } else if (stream.getVideoTracks().length === 0) {
        // 純語音流（螢幕分享的聲音跟著視訊流走，由 tile 的 <video> 播放）
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

    // 建立當下就把既有媒體軌加上：中途加入的人立刻收到目前的麥克風／螢幕分享
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

  function enterRoom() {
    showView(true);
    renderRoom();
    updateControlBar();
    startStats();
  }

  async function leaveRoomUI(silent = false) {
    if (!state.room) return;
    stopReconnect();
    reconnect.active = false;
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

    // 房主主動離開時通知所有人關房
    if (state.isHost && !silent) {
      broadcast({ type: 'room:closed' });
    }

    destroyPeer();
    clearStoredState();

    state.room = null;
    state.myId = null;
    state.participants = [];
    state.isHost = false;
    state.roomPassword = null;
    $('#btn-create').disabled = false;
    $('#btn-join').disabled = false;
    setBadge('就緒', 'on');
    showView(false);
  }

  /* ================= 房主：建房 ================= */

  function startHost(creds, opts = {}) {
    const restoring = !!opts.restoring;
    let attempts = opts.attempts || 0;
    state.nickname = creds.nickname;
    state.isHost = true;
    state.roomPassword = creds.password;
    setBadge('連線中…', '');

    const peer = new Peer(ROOM_PREFIX + creds.code, peerOptions());
    state.peer = peer;
    attachKeepalive(peer);

    let opened = false;

    peer.once('open', (id) => {
      opened = true;
      state.myId = id;
      state.room = { code: creds.code, name: creds.name };
      state.participants = [{
        id, name: creds.nickname, micOn: false, micMuted: false, screenOn: false, isOwner: true,
      }];
      saveHostState(creds);
      registerHostHandlers(peer);
      setBadge('🟢 已連線', 'on');
      enterRoom();
      toast(
        restoring
          ? `已恢復房主身分，房間碼不變：${creds.code}`
          : `房間建立成功！房間碼：${creds.code}`,
        'success'
      );
    });

    peer.on('error', (err) => {
      if (opened) return; // 建房後的錯誤由 attachKeepalive / 連線層處理
      if (err.type === 'unavailable-id') {
        // 房間碼剛好被占用（剛重整時舊連線尚未釋放、或極小機率撞碼）
        try { peer.destroy(); } catch {}
        if (state.peer === peer) state.peer = null;
        if (restoring) {
          // 恢復模式：堅持用同一組房間碼重試，維持房間延續性
          if (++attempts <= 8) {
            setTimeout(() => startHost(creds, { restoring: true, attempts }), 2000);
          } else {
            clearStoredState();
            $('#btn-create').disabled = false;
            setBadge('就緒', 'on');
            toast('無法恢復房間（房間碼暫時被占用），請重新建立房間', 'error');
          }
        } else {
          startHost({ ...creds, code: makeRoomCode() });
        }
        return;
      }
      $('#btn-create').disabled = false;
      setBadge('🔴 連線錯誤', 'off');
      toast('連線錯誤：' + err.type, 'error');
      try { peer.destroy(); } catch {}
      if (state.peer === peer) state.peer = null;
    });
  }

  function createRoom() {
    const nickname = $('#nickname').value.trim();
    const name = $('#create-name').value.trim();
    const password = $('#create-password').value;
    if (!nickname) return toast('請先填寫暱稱', 'error');
    if (!name) return toast('請填寫房間名稱', 'error');
    if (!password || password.length < 4) return toast('請設定至少 4 字的房間密碼', 'error');

    clearStoredState(); // 本分頁角色切換：清掉可能殘留的成員身分
    $('#btn-create').disabled = true;
    startHost({ nickname, name, password, code: makeRoomCode() });
  }

  // 房主端：處理加入者的密碼驗證
  function registerHostHandlers(peer) {
    peer.on('connection', (conn) => {
      let authenticated = false;
      // 10 秒內沒完成驗證就斷開，避免空連線占著
      const authTimeout = setTimeout(() => {
        if (!authenticated) { try { conn.close(); } catch {} }
      }, 10_000);

      conn.on('data', (msg) => {
        if (!msg || msg.type !== 'auth' || authenticated) return;
        clearTimeout(authTimeout);

        if ((authFails.get(conn.peer) || 0) >= AUTH_ATTEMPT_LIMIT) {
          try { conn.close(); } catch {}
          return;
        }
        if (String(msg.password) !== state.roomPassword) {
          authFails.set(conn.peer, (authFails.get(conn.peer) || 0) + 1);
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
        authFails.delete(conn.peer);
        if (!state.participants.some((p) => p.id === conn.peer)) {
          state.participants.push({
            id: conn.peer,
            name: String(msg.nickname || '未知').slice(0, 20),
            micOn: false,
            micMuted: false,
            screenOn: false,
            isOwner: false,
          });
        }
        setupDataConn(conn);

        conn.send({
          type: 'auth-ok',
          self: conn.peer,
          room: state.room,
          participants: state.participants,
        });
        broadcast({ type: 'participants', participants: state.participants });
        // 房主主動與新成員建立媒體連線：中途加入者立刻收到目前的麥克風／螢幕分享
        syncPeers(state.participants);
        toast(`${msg.nickname} 加入了房間`, 'success');
      });

      conn.on('close', () => {
        clearTimeout(authTimeout);
        // 只有「目前登記中的那條連線」斷開才算成員離開；
        // 重複連線會被 dedupe 關閉，不能誤判成離開
        if (authenticated && state.dataConns.get(conn.peer) === conn) {
          onPeerDisconnect(conn.peer);
        }
      });

      conn.on('error', (err) => {
        console.warn('Host conn error:', err);
      });
    });
  }

  /* ================= 成員：加入 ================= */

  async function joinRoom() {
    const nickname = $('#nickname').value.trim();
    const code = $('#join-code').value.trim().toUpperCase();
    const password = $('#join-password').value;
    if (!nickname) return toast('請先填寫暱稱', 'error');
    if (!code) return toast('請填寫房間碼', 'error');
    if (!password) return toast('請填寫房間密碼', 'error');

    clearStoredState(); // 本分頁角色切換：清掉可能殘留的房主身分
    $('#btn-join').disabled = true;
    setBadge('連線中…', '');

    const creds = { nickname, code, password };
    state.isHost = false;
    state.nickname = nickname;

    let lastErr = null;
    // 短暫的網路／信號抖動自動重試，不必讓使用者手動再點一次
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { conn, data } = await attemptJoin(creds);
        acceptJoin(conn, data, creds);
        toast(`已加入「${data.room.name}」`, 'success');
        return;
      } catch (err) {
        lastErr = err;
        if (err.fatal) break;
        destroyPeer();
        if (attempt < 2) await sleep(2500);
      }
    }

    destroyPeer();
    $('#btn-join').disabled = false;
    setBadge('🔴 連線錯誤', 'off');
    toast(
      lastErr && lastErr.message === '找不到房間'
        ? '找不到這個房間碼，請向房主確認'
        : (lastErr && lastErr.message) || '連線失敗',
      'error'
    );
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

  function saveSettings() {
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
      newPassword: password || undefined, // 告知已在房內的成員，讓他們斷線後仍能自動重連
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

    // 注意：這裡刻意不做 beforeunload 關房 —— 房主「重新整理」不算退出房間，
    // 房間要靠本機狀態＋成員端自動重連延續；只有房主主動按「離開」才關房。

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      const btn = $('#btn-screen');
      btn.disabled = true;
      btn.title = '此瀏覽器不支援螢幕分享（需要桌面版 Chrome／Edge）';
    }
  }

  /* ================= 啟動 ================= */

  /** 成員身分自動恢復（重新整理後），30 秒內反覆嘗試（房主可能也正在重整） */
  async function tryRestoreClient(creds) {
    const deadline = Date.now() + BOOT_RESTORE_WINDOW_MS;
    while (Date.now() < deadline) {
      try {
        const { conn, data } = await attemptJoin(creds);
        acceptJoin(conn, data, creds);
        toast('已重新加入房間', 'success');
        return true;
      } catch (err) {
        if (err.fatal) {
          toast(err.message, 'error');
          return false;
        }
        destroyPeer();
        await sleep(RECONNECT_INTERVAL_MS);
      }
    }
    return false;
  }

  async function boot() {
    bindUI();

    // 靜態版無房間列表，改為提示
    const box = $('#room-list');
    if (box) {
      box.textContent = '';
      box.appendChild(
        el('p', 'muted', '靜態版無法顯示房間列表。請直接輸入房間碼加入，或建立新房間。')
      );
    }

    const hostState = readStored(HOST_STATE_KEY);
    const clientState = readStored(CLIENT_STATE_KEY);

    if (hostState && hostState.code && hostState.name && hostState.password && hostState.nickname) {
      // 房主重新整理：自動以同一組房間碼恢復房間，房間碼與密碼都不變
      setBadge('恢復房間中…', '');
      startHost(hostState, { restoring: true });
      return;
    }

    if (clientState && clientState.code && clientState.password && clientState.nickname) {
      // 成員重新整理：自動重新加入同一個房間
      state.isHost = false;
      setBadge('重新加入房間中…', '');
      const ok = await tryRestoreClient(clientState);
      if (!ok) {
        destroyPeer();
        clearStoredState();
        setBadge('就緒', 'on');
        toast('房間目前連不上（可能已關閉），請重新加入', 'info');
      }
      return;
    }

    setBadge('就緒', 'on');
  }

  boot();
})();
