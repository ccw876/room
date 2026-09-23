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
    profile: { name: '', avatar: null }, // 個人中心：本機保存的暱稱／頭像
    avatars: new Map(),   // peerId -> 頭像 dataURL（其他成員的頭像，經 hello／profile 同步）
    participants: [],     // [{ id, name, micOn, micMuted, screenOn, isOwner }]
    dataConns: new Map(), // peerId -> DataConnection
    peers: new Map(),     // peerId -> { pc, polite, makingOffer, ignoreOffer, videoStream, stats, connState }
    micStream: null,
    micTrack: null,
    micMuted: false,
    screenStream: null,
    screenTrack: null,
    screenAudioTrack: null,
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
  // 遠端軌道只掛一次事件：重新協商／replaceTrack 會讓同一個 track 反覆觸發 ontrack，
  // 用 WeakSet 去重，避免 mute/unmute 監聽器隨投屏次數累積（越用越卡的元兇之一）
  const seenRemoteTracks = new WeakSet();

  /* ================= 文字聊天／檔案傳送 ================= */
  // 聊天與檔案都走既有的 P2P DataConnection（mesh：每對成員之間一條直連通道），
  // 訊息不經過任何伺服器；檔案以 base64 分片傳送，用 bufferedAmount 做背壓控制。
  const chat = {
    open: false,
    unread: 0,
    atBottom: true,
    lastSender: null,
    lastGroupTs: 0,
    typing: new Map(),    // peerId -> { name, timer }
    typingSent: false,
    typingSentAt: 0,
    typingOffTimer: null,
    transfers: new Map(), // fid -> 傳送狀態（收／發共用）
    urls: [],             // 已建立的 blob URL，離開房間時一併撤銷
    welcomed: false,
  };
  const FILE_CHUNK = 8_192;            // 每片原始位元組。base64 後約 11KB：必須低於 PeerJS chunkedMTU(16300)
                                       // 與 Safari 64KB 的 SCTP 訊息上限，否則大訊息會被静默丢棄導致「傳輸不完整」
  const FILE_MAX = 200 * 1024 * 1024;  // 單一檔案上限
  const FILE_BUFFER_HIGH = 8 * 1024 * 1024;
  const fileQueue = [];
  let fileSending = false;

  /* ================= 小工具 ================= */

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function genId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function nameHue(name) {
    return [...(name || '?')].reduce((a, c) => a + c.codePointAt(0), 0) % 360;
  }

  /* ================= 個人中心 ================= */

  function loadProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(PROFILE_KEY));
      if (p && typeof p === 'object') {
        return {
          name: typeof p.name === 'string' ? p.name.slice(0, 20) : '',
          avatar: typeof p.avatar === 'string' && p.avatar.startsWith('data:image/') ? p.avatar : null,
        };
      }
    } catch {}
    return { name: '', avatar: null };
  }

  function saveProfile() {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile)); } catch {}
  }

  /** 頭像圖片統一裁成 128×128 方形 JPEG（約 4-8KB），可直接放進 localStorage 與 P2P 訊息 */
  function compressAvatar(file) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) return reject(new Error('請選擇圖片檔'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const SIZE = 128;
          const cv = document.createElement('canvas');
          cv.width = SIZE;
          cv.height = SIZE;
          const ctx = cv.getContext('2d');
          const s = Math.max(SIZE / img.width, SIZE / img.height);
          const w = img.width * s;
          const h = img.height * s;
          ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
          resolve(cv.toDataURL('image/jpeg', 0.82));
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('圖片載入失敗'));
      };
      img.src = url;
    });
  }

  /** 取某成員的頭像：自己用本機 profile，其他人用同步過來的 avatars 表 */
  function avatarFor(id) {
    if (id === state.myId) return state.profile.avatar;
    return state.avatars.get(id) || null;
  }

  /** 把頭像（圖片或字首圓）畫到指定元素上 */
  function applyAvatar(elm, id, name) {
    if (!elm) return;
    const img = avatarFor(id);
    if (img) {
      elm.textContent = '';
      elm.style.backgroundImage = `url("${img}")`;
      elm.classList.add('avatar-img');
      return;
    }
    elm.style.backgroundImage = '';
    elm.classList.remove('avatar-img');
    elm.textContent = (name || '?').charAt(0).toUpperCase();
    elm.style.setProperty('--h', nameHue(name));
  }

  /** 大廳的頭像預覽跟著暱稱即時變動 */
  function renderLobbyAvatar() {
    const av = $('#lobby-avatar');
    if (!av) return;
    if (state.profile.avatar) {
      av.textContent = '';
      av.style.backgroundImage = `url("${state.profile.avatar}")`;
      av.classList.add('avatar-img');
      return;
    }
    av.style.backgroundImage = '';
    av.classList.remove('avatar-img');
    const name = $('#nickname').value.trim();
    av.textContent = (name || '?').charAt(0).toUpperCase();
    av.style.setProperty('--h', nameHue(name));
  }

  /** 套用新暱稱／頭像：更新本機、房內名單，並廣播給其他成員 */
  function applyMyProfile(name, avatar) {
    state.profile = { name, avatar };
    saveProfile();

    if (state.nickname !== name) {
      state.nickname = name;
      const me = state.participants.find((p) => p.id === state.myId);
      if (me) me.name = name;
    }
    if (state.room) {
      broadcast({ type: 'profile', name, avatar: avatar || null });
      renderRoom();
    }
    renderLobbyAvatar();
  }

  /** 房主端：目前房內所有人的頭像（自己用 profile，其他用同步表），排除指定成員 */
  function avatarsSnapshotFor(excludeId) {
    const out = {};
    if (state.profile.avatar) out[state.myId] = state.profile.avatar;
    for (const [id, av] of state.avatars) {
      if (id !== excludeId && av) out[id] = av;
    }
    return out;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return '?';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB'];
    let v = n;
    let u = -1;
    do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
    return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[u];
  }

  function chatTime(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  }

  function u8ToB64(u8) {
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < u8.length; i += step) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + step, u8.length)));
    }
    return btoa(bin);
  }

  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function maxBuffered() {
    let m = 0;
    for (const [, c] of state.dataConns) {
      const dc = c.dataChannel || c._dc;
      if (dc && typeof dc.bufferedAmount === 'number') m = Math.max(m, dc.bufferedAmount);
    }
    return m;
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
  const PROFILE_KEY = 'room.profile';        // 個人中心：{ name, avatar }，長期保存在這部裝置

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
    return q === 'ultra' ? 24_000_000 : q === 'text' ? 12_000_000 : 3_500_000;
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
      // 刻意不設 encodings.maxFramerate：擷取端 constraints 已限制幀率；
      // Chrome 在 replaceTrack 後沿用這個參數會把編碼幀率壓低（第二次分享變卡的元兇）
      e.scaleResolutionDownBy = 1; // 禁止瀏覽器自動降解析度，保住 1080p
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

  /* 讓傳輸優先採用 H.264：高幀率螢幕分享時硬體編碼器遠比 VP8／VP9 軟編穩定。
   * 只重排偏好順序（完整清單仍在），不影響互通性；需在協商開始前設定。 */
  function preferVideoCodecs(pc) {
    try {
      const caps = RTCRtpSender.getCapabilities('video');
      if (!caps || !Array.isArray(caps.codecs) || caps.codecs.length === 0) return;
      const rank = (c) => {
        const m = (c.mimeType || '').toLowerCase();
        if (m.includes('h264')) return 0;
        if (m.includes('av1')) return 1;
        if (m.includes('vp9')) return 2;
        if (m.includes('vp8')) return 3;
        return 4;
      };
      const ordered = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
      for (const t of pc.getTransceivers()) {
        if (t.sender && t.sender.track && t.sender.track.kind === 'video') {
          try { t.setCodecPreferences(ordered); } catch {}
        }
      }
    } catch {}
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

      case 'chat': {
        const p = state.participants.find((x) => x.id === fromPeerId);
        const text = String(msg.text ?? '').slice(0, 2000);
        if (text) {
          appendChatText(fromPeerId, p ? p.name : '未知', msg.ts || Date.now(), text, false);
          noteIncoming();
        }
        break;
      }

      case 'typing': {
        const p = state.participants.find((x) => x.id === fromPeerId);
        if (!p) break;
        const cur = chat.typing.get(fromPeerId);
        if (msg.on) {
          if (cur) clearTimeout(cur.timer);
          chat.typing.set(fromPeerId, {
            name: p.name,
            timer: setTimeout(() => { chat.typing.delete(fromPeerId); renderTyping(); }, 4000),
          });
        } else if (cur) {
          clearTimeout(cur.timer);
          chat.typing.delete(fromPeerId);
        }
        renderTyping();
        break;
      }

      case 'file:start': {
        if (chat.transfers.has(msg.fid)) break;
        const fid = String(msg.fid || '');
        const size = Number(msg.size) || 0;
        if (!fid || size <= 0) break;
        const p = state.participants.find((x) => x.id === fromPeerId);
        if (size > FILE_MAX) {
          toast(`「${String(msg.name || '檔案')}」超過 ${fmtBytes(FILE_MAX)} 上限，已拒收`, 'error');
          sendTo(fromPeerId, { type: 'file:abort', fid });
          break;
        }
        const t = registerTransfer({
          fid,
          name: String(msg.name || '未命名檔案').slice(0, 120),
          size,
          mime: String(msg.mime || 'application/octet-stream'),
          ts: msg.ts || Date.now(),
          dir: 'recv',
        });
        appendFileMsg(t, false, p ? p.name : '未知', fromPeerId);
        noteIncoming();
        break;
      }

      case 'file:chunk': {
        const t = chat.transfers.get(String(msg.fid || ''));
        if (!t || t.dir !== 'recv' || t.done || t.cancelled) break;
        const seq = Number(msg.seq) | 0;
        if (seq < 0 || seq > 200_000) break;
        try {
          const u8 = b64ToU8(String(msg.data || ''));
          t.chunks[seq] = u8;
          t.received += u8.byteLength;
          updateTransferProgress(t);
        } catch { /* 壞片直接略過，end 時會檢查完整性 */ }
        break;
      }

      case 'file:end': {
        const t = chat.transfers.get(String(msg.fid || ''));
        if (!t || t.dir !== 'recv' || t.done) break;
        const expected = Math.max(1, Math.ceil(t.size / FILE_CHUNK));
        const got = t.chunks.filter(Boolean).length;
        if (got !== expected) {
          t.failed = true;
          setTransferStatus(t, `傳輸不完整（收到 ${got}/${expected} 片）`);
        } else {
          finalizeTransfer(t);
        }
        break;
      }

      case 'file:abort': {
        const t = chat.transfers.get(String(msg.fid || ''));
        if (!t || t.done) break;
        if (t.dir === 'recv') {
          t.cancelled = true;
          t.chunks = [];
          setTransferStatus(t, '對方已取消傳送');
        } else {
          // 收到拒收通知（例如對方拒收超限檔案）：中止自己的傳送迴圈
          t.cancelled = true;
        }
        break;
      }

      case 'hello': {
        const existing = state.participants.find((p) => p.id === fromPeerId);
        if (typeof msg.avatar === 'string' && msg.avatar.startsWith('data:image/')) {
          state.avatars.set(fromPeerId, msg.avatar);
        }
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
          if (msg.name) {
            toast(`${msg.name} 加入了房間`, 'success');
            addSysMsg(`${msg.name} 加入了房間`);
          }
        } else {
          if (msg.name && existing.name !== msg.name) existing.name = msg.name;
          renderRoom();
        }
        break;
      }

      case 'profile': {
        // 其他成員更新了暱稱／頭像
        if (typeof msg.avatar === 'string' && msg.avatar.startsWith('data:image/')) {
          state.avatars.set(fromPeerId, msg.avatar);
        } else if (msg.avatar === null) {
          state.avatars.delete(fromPeerId);
        }
        const p = state.participants.find((x) => x.id === fromPeerId);
        if (p && typeof msg.name === 'string' && msg.name && p.name !== msg.name) {
          p.name = msg.name.slice(0, 20);
          toast(`${msg.name} 更新了個人資料`);
          addSysMsg(`${p.name} 更名為 ${msg.name}`);
        }
        if (state.isHost) {
          // 房主維護權威名單：同步後重播給所有人收斂
          broadcast({ type: 'participants', participants: state.participants });
        }
        renderRoom();
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
      addSysMsg(`${p.name} 離開了房間`);
      const tp = chat.typing.get(peerId);
      if (tp) { clearTimeout(tp.timer); chat.typing.delete(peerId); renderTyping(); }
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
        avatar: state.profile.avatar || undefined,
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
          avatar: state.profile.avatar || undefined,
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

    // 房主在 auth-ok 附上目前成員的頭像，中途加入立即看得到大家的大頭照
    if (data.avatars && typeof data.avatars === 'object') {
      for (const [id, av] of Object.entries(data.avatars)) {
        if (typeof av === 'string' && av.startsWith('data:image/')) state.avatars.set(id, av);
      }
    }

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

    // 向房主補一份 hello：讓房主立即拿到自己的頭像（auth 只帶了暱稱）
    sendTo(conn.peer, {
      type: 'hello',
      name: state.nickname,
      avatar: state.profile.avatar || undefined,
      micOn: !!state.micStream,
      micMuted: state.micMuted,
      screenOn: !!state.screenStream,
    });

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
        if (!seenRemoteTracks.has(e.track)) {
          seenRemoteTracks.add(e.track);
          e.track.addEventListener('ended', () => {
            if (peer.videoStream === stream) {
              peer.videoStream = null;
              renderRoom();
            }
          });
          // 對方停止分享後遠端軌會變 muted（不是 ended）：及時切回頭像，不留殘影
          e.track.addEventListener('mute', () => renderRoom());
          e.track.addEventListener('unmute', () => renderRoom());
        }
      } else if (e.track.kind === 'audio') {
        if (stream.getVideoTracks().length === 0) {
          // 純語音流（麥克風）
          attachRemoteAudio(peerId, stream);
        } else {
          // 螢幕分享的系統／分頁聲音：跟視訊掛同一條 stream，用獨立 <audio> 播放；
          // 以 track.id 為 key，replaceTrack 重用同一條 m-line 時不會重複建元素
          attachRemoteAudio(peerId, new MediaStream([e.track]), 'sa:' + e.track.id);
        }
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
      peer.videoSender = sender;
      applySenderQuality(sender);
      if (state.screenAudioTrack) {
        peer.screenAudioSender = pc.addTrack(state.screenAudioTrack, state.screenStream);
      }
    }
    preferVideoCodecs(pc); // 需在 negotiationneeded 觸發前完成

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

  function attachRemoteAudio(peerId, stream, keyOverride) {
    if (stream.getVideoTracks().length > 0) return;
    const key = keyOverride || `${peerId}:${stream.id}`;
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
    state.screenAudioTrack = stream.getAudioTracks()[0] || null;
    track.contentHint = state.quality === 'text' ? 'detail' : 'motion';
    track.addEventListener('ended', () => stopScreenShare());

    for (const [, peer] of state.peers) {
      // 優先 replaceTrack：第二次起的分享完全不觸發重新協商，
      // m-line 與編碼器設定保持原狀，避免重複協商造成的效能劣化
      let reused = false;
      if (peer.videoSender) {
        try {
          await peer.videoSender.replaceTrack(track);
          reused = true;
        } catch {
          peer.videoSender = null;
        }
      }
      if (!reused) {
        const sender = peer.pc.addTrack(track, stream);
        peer.videoSender = sender;
      }
      // 螢幕分享的系統／分頁聲音：跟視訊走同一條 stream（各自的 m-line）
      if (state.screenAudioTrack) {
        if (peer.screenAudioSender) {
          try {
            await peer.screenAudioSender.replaceTrack(state.screenAudioTrack);
          } catch {
            peer.screenAudioSender = null;
          }
        }
        if (!peer.screenAudioSender) {
          peer.screenAudioSender = peer.pc.addTrack(state.screenAudioTrack, stream);
        }
      }
      await applySenderQuality(peer.videoSender);
      preferVideoCodecs(peer.pc);
    }

    emitState();
    updateControlBar();
    renderRoom();

    const s = track.getSettings();
    const fps = s.frameRate ? Math.round(s.frameRate) : null;
    toast(
      `開始分享（擷取 ${s.width || '?'}x${s.height || '?'} @ ${fps ?? '—'}fps）` +
        `\n🔊 ${state.screenAudioTrack
          ? '已分享聲音'
          : '未分享聲音（在 Chrome 的分享視窗勾選「同時分享音訊」即可）'}` +
        (state.quality === 'ultra' && fps !== null && fps < 120 ? '\n⚠️ 目前低於 120fps 目標' : ''),
      fps !== null && fps < 120 ? 'info' : 'success'
    );
  }

  async function stopScreenShare() {
    const stream = state.screenStream;
    if (!stream) return;
    state.screenStream = null;
    state.screenTrack = null;
    state.screenAudioTrack = null;
    stream.getTracks().forEach((t) => t.stop());
    // replaceTrack(null) 不觸發重新協商：m-line 留著、編碼器參數不動，
    // 下次分享 replaceTrack 新軌即可；這是「第二次投屏變卡」的根本修法
    for (const [, peer] of state.peers) {
      if (peer.videoSender) {
        try {
          await peer.videoSender.replaceTrack(null);
        } catch {
          try { peer.pc.removeTrack(peer.videoSender); } catch {}
          peer.videoSender = null;
        }
      } else {
        const sender = peer.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) { try { peer.pc.removeTrack(sender); } catch {} }
      }
      if (peer.screenAudioSender) {
        try {
          await peer.screenAudioSender.replaceTrack(null);
        } catch {
          try { peer.pc.removeTrack(peer.screenAudioSender); } catch {}
          peer.screenAudioSender = null;
        }
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
    const fsBtn = el('button', 'btn-fs');
    fsBtn.appendChild(icon('maximize'));
    fsBtn.title = '全螢幕（或雙擊畫面）';
    fsBtn.setAttribute('aria-label', '全螢幕');
    fsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen(root);
    });
    topRight.append(statsEl, fsBtn);
    top.append(badgeOwner, topRight);

    const bottom = el('div', 'tile-bottom');
    const nameRow = el('div', 'tile-namerow');
    const badgeMic = el('span', 'tile-ico muted-ico hidden');
    badgeMic.appendChild(icon('mic-off'));
    badgeMic.title = '麥克風已靜音';
    const badgeScreen = el('span', 'tile-ico screen-ico hidden');
    badgeScreen.appendChild(icon('screen'));
    badgeScreen.title = '正在分享螢幕';
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

    // 依加入順序原地更新磚塊；既有磚的 DOM 節點與視訊串流不動，不閃爍
    const seen = new Set();

    for (const p of state.participants) {
      seen.add(p.id);
      const tile = ensureTile(p);
      const isSelf = p.id === state.myId;
      const peer = state.peers.get(p.id);

      tile.nameEl.textContent = p.name + (isSelf ? '（我）' : '');
      tile.badgeOwner.classList.toggle('hidden', !p.isOwner);
      tile.badgeMic.classList.toggle('hidden', !(p.micOn && p.micMuted));
      tile.badgeScreen.classList.toggle('hidden', !p.screenOn);

      const stream = isSelf ? state.screenStream : (peer && peer.videoStream) || null;
      // muted 的軌道（對方已停止分享）不算有畫面，避免殘留最後一影格
      const hasVideo = !!(stream && stream.getVideoTracks().some((tr) => tr.readyState === 'live' && !tr.muted));

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

      applyAvatar(tile.avatarCircle, p.id, p.name);

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

  /* ================= 聊天：面板與訊息渲染 ================= */

  function setChatOpen(open) {
    const view = $('#view-room');
    if (!view) return;
    chat.open = !!open;
    view.classList.toggle('chat-open', chat.open);
    if (chat.open) {
      chat.unread = 0;
      updateUnreadBadge();
      scrollChat(true);
      if (window.innerWidth > 920) $('#chat-input').focus({ preventScroll: true });
    }
  }

  function updateUnreadBadge() {
    const b = $('#chat-unread');
    if (!b) return;
    b.textContent = chat.unread > 99 ? '99+' : String(chat.unread);
    b.classList.toggle('hidden', chat.unread === 0);
  }

  function showJump() { const j = $('#chat-jump'); if (j) j.classList.remove('hidden'); }
  function hideJump() { const j = $('#chat-jump'); if (j) j.classList.add('hidden'); }

  function scrollChat(force) {
    const box = $('#chat-messages');
    if (!box) return;
    if (force) {
      box.scrollTop = box.scrollHeight;
      chat.atBottom = true;
      hideJump();
      return;
    }
    if (chat.atBottom) box.scrollTop = box.scrollHeight;
  }

  function noteIncoming() {
    if (!state.room) return;
    if (!chat.open) {
      chat.unread++;
      updateUnreadBadge();
    } else if (!chat.atBottom) {
      showJump();
    }
    scrollChat(false);
  }

  /** 建立訊息列外框（頭像／名稱／時間，連續同人的訊息合併分組） */
  function buildMsgScaffold(fromId, name, ts, isSelf) {
    const box = $('#chat-messages');
    const grouped = chat.lastSender === fromId && (ts - chat.lastGroupTs) < 180_000;
    chat.lastSender = fromId;
    chat.lastGroupTs = ts;

    const root = el('div', 'msg ' + (isSelf ? 'me' : 'them') + (grouped ? ' grouped' : ''));
    if (!isSelf && !grouped) {
      const av = el('div', 'msg-avatar');
      applyAvatar(av, fromId, name);
      root.appendChild(av);
    }
    const col = el('div', 'msg-col');
    if (!grouped) {
      const meta = el('div', 'msg-meta');
      if (!isSelf) {
        const nm = el('span', 'msg-name', name);
        nm.style.color = `hsl(${nameHue(name)} 72% 74%)`;
        meta.appendChild(nm);
      }
      meta.appendChild(el('span', 'msg-time', chatTime(ts)));
      col.appendChild(meta);
    }
    const bubble = el('div', 'bubble');
    col.appendChild(bubble);
    root.appendChild(col);
    box.appendChild(root);
    return { root, col, bubble };
  }

  /** 純文字 + 自動連結（DOM 方式組裝，不吃 HTML） */
  function appendTextWithLinks(node, text) {
    const re = /(https?:\/\/[^\s<>"']+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[0];
      node.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }

  function appendChatText(fromId, name, ts, text, isSelf) {
    const s = buildMsgScaffold(fromId, name, ts, isSelf);
    appendTextWithLinks(s.bubble, text);
    scrollChat(isSelf);
  }

  function addSysMsg(text) {
    const box = $('#chat-messages');
    if (!box) return;
    box.appendChild(el('div', 'msg-sys', text));
    chat.lastSender = null; // 系統訊息切斷視覺分組
    scrollChat(false);
  }

  /* ================= 聊天：送出文字／輸入中提示 ================= */

  function sendChatText() {
    const ta = $('#chat-input');
    const text = ta.value.trim();
    if (!text || !state.room) return;
    if (!state.dataConns.size) toast('目前沒有其他成員，訊息只有自己看得到', 'info');
    const ts = Date.now();
    broadcast({ type: 'chat', mid: genId(), text, ts });
    appendChatText(state.myId, state.nickname, ts, text, true);
    ta.value = '';
    autosizeChatInput();
    $('#btn-chat-send').disabled = true;
    stopTypingSignal();
  }

  function notifyTyping() {
    if (!state.room || !state.dataConns.size) return;
    if (!chat.typingSent) {
      chat.typingSent = true;
      broadcast({ type: 'typing', on: true });
    }
    chat.typingSentAt = Date.now();
    clearTimeout(chat.typingOffTimer);
    chat.typingOffTimer = setTimeout(stopTypingSignal, 2500);
  }

  function stopTypingSignal() {
    clearTimeout(chat.typingOffTimer);
    chat.typingOffTimer = null;
    if (chat.typingSent) {
      chat.typingSent = false;
      if (state.room && state.dataConns.size) broadcast({ type: 'typing', on: false });
    }
  }

  function renderTyping() {
    const elx = $('#chat-typing');
    if (!elx) return;
    const names = [...chat.typing.values()].map((t) => t.name);
    elx.textContent = names.length ? `${names.join('、')} 正在輸入…` : '';
    elx.classList.toggle('hidden', !names.length);
  }

  function autosizeChatInput() {
    const ta = $('#chat-input');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  }

  /* ================= 聊天：檔案傳送 ================= */

  function isImageMime(mime) {
    return /^image\//.test(mime || '');
  }

  function registerTransfer(meta) {
    const t = {
      ...meta,
      chunks: [],
      received: 0,
      cancelled: false,
      failed: false,
      done: false,
      lastUi: 0,
      blobUrl: null,
      els: null,
    };
    chat.transfers.set(meta.fid, t);
    return t;
  }

  function appendFileMsg(t, isSelf, fromName, fromId) {
    const s = buildMsgScaffold(fromId, fromName, t.ts, isSelf);
    const card = el('div', 'file-card');
    const icoWrap = el('span', 'file-ico');
    icoWrap.appendChild(icon(isImageMime(t.mime) ? 'image' : 'file'));
    const main = el('div', 'file-main');
    main.appendChild(el('div', 'file-name', t.name));
    const bar = el('div', 'file-bar');
    const barIn = el('div', 'file-bar-in');
    bar.appendChild(barIn);
    const sub = el('div', 'file-sub', isSelf ? '準備傳送…' : '接收中…');
    main.append(bar, sub);
    const action = el('span', 'file-action');
    card.append(icoWrap, main, action);
    s.bubble.appendChild(card);
    t.els = { bubble: s.bubble, bar, barIn, sub, action };
    scrollChat(isSelf);
  }

  function updateTransferProgress(t) {
    if (!t.els || !t.size) return;
    const pct = Math.min(100, Math.round((t.received / t.size) * 100));
    const now = Date.now();
    if (pct < 100 && now - t.lastUi < 90) return; // 節流，避免高頻改 DOM
    t.lastUi = now;
    t.els.barIn.style.width = pct + '%';
    t.els.sub.textContent = `${fmtBytes(t.received)} / ${fmtBytes(t.size)}（${pct}%）`;
  }

  function setTransferStatus(t, text, bad = true) {
    if (!t.els) return;
    t.els.bar.classList.add('off');
    t.els.sub.textContent = text;
    t.els.sub.style.color = bad ? 'var(--red)' : '';
  }

  function finalizeTransfer(t, prebuiltBlob) {
    t.done = true;
    let blob;
    try {
      blob = prebuiltBlob || new Blob(t.chunks, { type: t.mime || 'application/octet-stream' });
    } catch {
      t.failed = true;
      setTransferStatus(t, '組合檔案失敗');
      return;
    }
    t.chunks = [];
    try { t.blobUrl = URL.createObjectURL(blob); } catch { t.blobUrl = null; }
    if (t.blobUrl) chat.urls.push(t.blobUrl);
    if (!t.els) return;
    t.els.bar.classList.add('done');
    t.els.sub.textContent = fmtBytes(t.size);
    t.els.sub.style.color = '';
    if (t.blobUrl) {
      const a = document.createElement('a');
      a.className = 'file-dl';
      a.href = t.blobUrl;
      a.download = t.name;
      a.appendChild(icon('download'));
      a.appendChild(document.createTextNode('下載'));
      t.els.action.appendChild(a);
      if (isImageMime(t.mime) && t.size <= 25 * 1024 * 1024) {
        const img = document.createElement('img');
        img.className = 'msg-img';
        img.alt = t.name;
        img.src = t.blobUrl;
        img.loading = 'lazy';
        img.addEventListener('click', () => window.open(t.blobUrl, '_blank'));
        t.els.bubble.insertBefore(img, t.els.bubble.firstChild);
      }
    }
  }

  function enqueueFiles(files) {
    if (!state.room || !files || !files.length) return;
    let queued = 0;
    for (const f of files) {
      if (!f) continue;
      if (f.size > FILE_MAX) {
        toast(`「${f.name}」超過 ${fmtBytes(FILE_MAX)} 單檔上限，已略過`, 'error');
        continue;
      }
      fileQueue.push(f);
      queued++;
    }
    if (queued && !state.dataConns.size) toast('目前沒有其他成員，檔案不會傳給任何人', 'info');
    if (fileQueue.length && !fileSending) runFileQueue();
  }

  async function runFileQueue() {
    fileSending = true;
    while (fileQueue.length) {
      const f = fileQueue.shift();
      try {
        await sendFile(f);
      } catch (err) {
        console.warn('sendFile failed:', err);
      }
    }
    fileSending = false;
  }

  async function sendFile(file) {
    if (!state.room || !state.dataConns.size) return;
    const fid = genId();
    const t = registerTransfer({
      fid,
      fromId: state.myId,
      name: file.name || '未命名檔案',
      size: file.size,
      mime: file.type || 'application/octet-stream',
      ts: Date.now(),
      dir: 'send',
    });
    appendFileMsg(t, true, state.nickname, state.myId);
    broadcast({ type: 'file:start', fid, name: t.name, size: t.size, mime: t.mime, ts: t.ts });

    try {
      let seq = 0;
      let offset = 0;
      while (offset < t.size) {
        if (t.cancelled) throw Object.assign(new Error('cancelled'), { silent: true });
        const buf = await file.slice(offset, offset + FILE_CHUNK).arrayBuffer();
        if (t.cancelled) throw Object.assign(new Error('cancelled'), { silent: true });
        broadcast({ type: 'file:chunk', fid, seq, data: u8ToB64(new Uint8Array(buf)) });
        offset += buf.byteLength;
        seq++;
        t.received = offset;
        updateTransferProgress(t);
        // 背壓控制：任一連線緩衝超過水位就稍等，避免塞爆 SCTP 緩衝
        let guard = 0;
        while (maxBuffered() > FILE_BUFFER_HIGH) {
          await sleep(25);
          if (t.cancelled) throw Object.assign(new Error('cancelled'), { silent: true });
          if (++guard > 800) throw new Error('傳送停滯（對方長時間未接收）');
        }
      }
      broadcast({ type: 'file:end', fid });
      finalizeTransfer(t, file);
    } catch (err) {
      broadcast({ type: 'file:abort', fid });
      t.cancelled = true;
      if (t.els) {
        t.els.bar.classList.add('off');
        t.els.sub.textContent = err && err.silent ? '已取消' : '傳送失敗';
        t.els.sub.style.color = err && err.silent ? '' : 'var(--red)';
      }
      if (!err || !err.silent) toast(`「${t.name}」傳送失敗：${(err && err.message) || '未知錯誤'}`, 'error');
    }
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
    mic.classList.toggle('active', !!state.micStream);
    mic.title = state.micStream ? '關閉麥克風' : '開啟麥克風';
    mic.querySelector('.ctl-label').textContent = state.micStream ? '關閉麥克風' : '開啟麥克風';

    const mute = $('#btn-mute');
    mute.disabled = !state.micStream;
    mute.classList.toggle('active', state.micMuted);
    mute.title = state.micMuted ? '取消靜音' : '靜音';
    mute.querySelector('.ctl-label').textContent = state.micMuted ? '取消靜音' : '靜音';

    const screen = $('#btn-screen');
    screen.classList.toggle('active', !!state.screenStream);
    screen.title = state.screenStream ? '停止分享' : '分享螢幕';
    screen.querySelector('.ctl-label').textContent = state.screenStream ? '停止分享' : '分享螢幕';
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
    if (!chat.welcomed) {
      chat.welcomed = true;
      addSysMsg('歡迎使用聊天室：訊息與檔案在成員之間點對點直傳，不經過伺服器');
    }
    // 寬螢幕預設展開聊天欄，窄螢幕收起（可隨時用下方「聊天」切換）
    if (window.innerWidth >= 1100) setChatOpen(true);
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

    // 清理聊天／檔案傳送狀態
    fileQueue.length = 0;
    fileSending = false;
    for (const [, t] of chat.transfers) { t.cancelled = true; }
    chat.transfers.clear();
    for (const u of chat.urls) { try { URL.revokeObjectURL(u); } catch {} }
    chat.urls = [];
    for (const [, tp] of chat.typing) clearTimeout(tp.timer);
    chat.typing.clear();
    clearTimeout(chat.typingOffTimer);
    chat.typingSent = false;
    chat.unread = 0;
    chat.lastSender = null;
    chat.atBottom = true;
    chat.welcomed = false;
    renderTyping();
    updateUnreadBadge();
    const box = $('#chat-messages');
    if (box) box.textContent = '';
    setChatOpen(false);

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
          avatars: avatarsSnapshotFor(conn.peer),
        });
        broadcast({ type: 'participants', participants: state.participants });
        // 房主主動與新成員建立媒體連線：中途加入者立刻收到目前的麥克風／螢幕分享
        syncPeers(state.participants);
        renderRoom(); // 原地更新人數與名單，頁面不重新載入
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

  /* ================= 個人中心彈窗 ================= */

  let pendingAvatar = null; // 彈窗中暫存的新頭像（未儲存前不生效）

  function renderProfilePreview() {
    const prev = $('#profile-avatar-preview');
    if (!prev) return;
    if (pendingAvatar) {
      prev.textContent = '';
      prev.style.backgroundImage = `url("${pendingAvatar}")`;
      prev.classList.add('avatar-img');
    } else {
      prev.style.backgroundImage = '';
      prev.classList.remove('avatar-img');
      const name = $('#profile-name').value.trim();
      prev.textContent = (name || '?').charAt(0).toUpperCase();
      prev.style.setProperty('--h', nameHue(name));
    }
  }

  function openProfileModal() {
    $('#profile-name').value = state.profile.name || $('#nickname').value.trim();
    pendingAvatar = state.profile.avatar;
    renderProfilePreview();
    $('#modal-profile').classList.remove('hidden');
  }

  function closeProfileModal() {
    $('#modal-profile').classList.add('hidden');
  }

  function saveProfileModal() {
    const name = $('#profile-name').value.trim();
    if (!name) return toast('請填寫暱稱', 'error');
    applyMyProfile(name, pendingAvatar);
    $('#nickname').value = name;
    closeProfileModal();
    toast('個人資料已儲存，下次開啟自動帶入', 'success');
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

    /* ---------- 個人中心 ---------- */
    $('#btn-profile').addEventListener('click', openProfileModal);
    $('#btn-profile-cancel').addEventListener('click', closeProfileModal);
    $('#btn-profile-save').addEventListener('click', saveProfileModal);
    $('#modal-profile').addEventListener('click', (e) => {
      if (e.target === $('#modal-profile')) closeProfileModal();
    });
    $('#btn-avatar-upload').addEventListener('click', () => $('#avatar-file').click());
    $('#btn-avatar-remove').addEventListener('click', () => {
      pendingAvatar = null;
      renderProfilePreview();
    });
    $('#avatar-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        pendingAvatar = await compressAvatar(file);
        renderProfilePreview();
      } catch (err) {
        toast(err.message || '頭像處理失敗', 'error');
      }
    });
    $('#nickname').addEventListener('input', renderLobbyAvatar);

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

    /* ---------- 聊天 ---------- */
    $('#btn-chat').addEventListener('click', () => setChatOpen(!chat.open));
    $('#btn-chat-close').addEventListener('click', () => setChatOpen(false));
    $('#chat-scrim').addEventListener('click', () => setChatOpen(false));
    $('#chat-jump').addEventListener('click', () => { hideJump(); scrollChat(true); });
    $('#btn-chat-send').addEventListener('click', sendChatText);
    $('#btn-chat-attach').addEventListener('click', () => $('#chat-file-input').click());
    $('#chat-file-input').addEventListener('change', (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      enqueueFiles(files);
    });

    const chatInput = $('#chat-input');
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatText();
      }
    });
    chatInput.addEventListener('input', () => {
      autosizeChatInput();
      $('#btn-chat-send').disabled = !chatInput.value.trim();
      notifyTyping();
    });
    // 直接貼上截圖／圖片即可傳送
    chatInput.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) {
        e.preventDefault();
        enqueueFiles(files);
      }
    });

    // 拖放檔案到聊天欄即可傳送
    const panel = $('#chat-panel');
    ['dragenter', 'dragover'].forEach((ev) =>
      panel.addEventListener(ev, (e) => { e.preventDefault(); panel.classList.add('dragging'); })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      panel.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev === 'drop') {
          const files = [...(e.dataTransfer?.files || [])];
          if (files.length) enqueueFiles(files);
        } else if (e.relatedTarget && panel.contains(e.relatedTarget)) {
          return; // 还在面板内部移动，不取消提示
        }
        panel.classList.remove('dragging');
      })
    );

    const msgBox = $('#chat-messages');
    msgBox.addEventListener('scroll', () => {
      chat.atBottom = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 60;
      if (chat.atBottom) hideJump();
    });

    // 從最小化／背景分頁回到前景：恢復影片播放、立即刷新統計，
    // 消除「最小化回來後畫面卡住／角標停更」的問題
    const resumeMedia = () => {
      if (document.visibilityState !== 'visible' || !state.room) return;
      for (const [, tile] of tileEls) {
        if (tile.attached && tile.video.paused) tile.video.play().catch(() => {});
      }
      pollStats();
    };
    document.addEventListener('visibilitychange', resumeMedia);
    window.addEventListener('focus', resumeMedia);

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

  /* ================= 深淺色主題 ================= */

  const THEME_KEY = 'room.theme';

  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0f1115' : '#f5f6f8');
    try { localStorage.setItem(THEME_KEY, t); } catch {}
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch {}
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));
    for (const btn of document.querySelectorAll('.theme-toggle')) {
      btn.addEventListener('click', () => {
        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      });
    }
  }

  async function boot() {
    initTheme();
    bindUI();

    // 個人中心：本機保存的暱稱／頭像，每次開啟自動帶入
    state.profile = loadProfile();
    if (state.profile.name) $('#nickname').value = state.profile.name;
    renderLobbyAvatar();

    setBadge('就緒', 'on');

    const hostState = readStored(HOST_STATE_KEY);
    const clientState = readStored(CLIENT_STATE_KEY);

    if (hostState && hostState.code && hostState.name && hostState.password && hostState.nickname) {
      // 房主重新整理：自動以同一組房間碼恢復房間，房間碼與密碼都不變
      if (state.profile.name) hostState.nickname = state.profile.name; // 用最新暱稱
      setBadge('恢復房間中…', '');
      startHost(hostState, { restoring: true });
      return;
    }

    if (clientState && clientState.code && clientState.password && clientState.nickname) {
      // 成員重新整理：自動重新加入同一個房間
      state.isHost = false;
      if (state.profile.name) clientState.nickname = state.profile.name; // 用最新暱稱
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
