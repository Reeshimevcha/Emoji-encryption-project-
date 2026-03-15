/**
 * EmojiChat v2 — Main Application
 * Features: room types (duo/group), max users, read permissions,
 * rotating emoji cipher, scheduled messages, message reactions,
 * file uploads, delivery+read receipts, self-destruct timers.
 */

// ── Firebase init ─────────────────────────────────────────────────────────────
firebase.initializeApp(firebaseConfig);
const db      = firebase.database();
const storage = firebase.storage();

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  userId:    sessionStorage.getItem('ec_uid')  || crypto.randomUUID(),
  username:  sessionStorage.getItem('ec_name') || null,
  roomCode:  null,
  roomType:  null,   // 'duo' | 'group'
  maxUsers:  0,      // 0 = unlimited
  isOwner:   false,
  canRead:   false,  // set by owner's permission grant
  listeners: [],
  timers:    {},
  schedTimers: {},
  revealed:  new Set(),
  globalReveal: false,
  pendingFile:  null,
  reactionPickerTarget: null,
  scheduledTime: null,
};
sessionStorage.setItem('ec_uid', S.userId);

// ── Utilities ─────────────────────────────────────────────────────────────────
const $    = id  => document.getElementById(id);
const ce   = tag => document.createElement(tag);
const fmt  = ts  => new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
const fmtDateTime = ts => new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
const fmtSize = b => b < 1024 ? `${b}B` : b < 1048576 ? `${(b/1024).toFixed(1)}KB` : `${(b/1048576).toFixed(1)}MB`;

function toast(msg, type = 'info') {
  const t = ce('div'); t.className = `toast toast-${type}`; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3000);
}
function copy(text) { navigator.clipboard.writeText(text).then(() => toast('Copied!', 'success')); }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = $(id); if (s) s.classList.add('active');
}
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initLanding();
  initChat();
  // Close reaction picker on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.reaction-picker') && !e.target.closest('.btn-react'))
      closeReactionPicker();
  });
});

// ── Landing screen ────────────────────────────────────────────────────────────
function initLanding() {
  // Room type toggle
  document.querySelectorAll('.type-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.type-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const type = card.dataset.type;
      $('group-options').classList.toggle('hidden', type !== 'group');
    });
  });

  // Max users toggle
  $('max-unlimited').addEventListener('change', e => {
    $('max-users-row').classList.toggle('hidden', e.target.checked);
  });

  $('btn-create').addEventListener('click', handleCreate);
  $('btn-join-tab').addEventListener('click', () => {
    $('tab-create').classList.remove('active');
    $('tab-join').classList.add('active');
    $('panel-create').classList.add('hidden');
    $('panel-join').classList.remove('hidden');
  });
  $('btn-create-tab').addEventListener('click', () => {
    $('tab-join').classList.remove('active');
    $('tab-create').classList.add('active');
    $('panel-join').classList.add('hidden');
    $('panel-create').classList.remove('hidden');
  });
  $('btn-join').addEventListener('click', handleJoin);
}

// ── Create room ────────────────────────────────────────────────────────────────
async function handleCreate() {
  const name = $('username-create').value.trim();
  if (!name) { toast('Enter your name', 'error'); return; }

  const typeCard = document.querySelector('.type-card.selected');
  const type     = typeCard ? typeCard.dataset.type : 'duo';
  const maxUsers = type === 'group'
    ? ($('max-unlimited').checked ? 0 : parseInt($('max-users-val').value) || 0)
    : 2;

  S.username = name; S.isOwner = true; S.roomType = type;
  S.maxUsers = maxUsers; S.roomCode = genCode(); S.canRead = true;
  sessionStorage.setItem('ec_name', name);

  await db.ref(`rooms/${S.roomCode}`).set({
    type, maxUsers, owner: S.userId, created: Date.now(), closed: false,
  });
  await db.ref(`rooms/${S.roomCode}/users/${S.userId}`).set({
    name, online: true, joinedAt: Date.now(), canRead: true,
  });
  db.ref(`rooms/${S.roomCode}/users/${S.userId}/online`).onDisconnect().set(false);

  enterChat();
}

// ── Join room ──────────────────────────────────────────────────────────────────
async function handleJoin() {
  const name = $('username-join').value.trim();
  const code = $('room-code-input').value.trim().toUpperCase();
  if (!name) { toast('Enter your name', 'error'); return; }
  if (code.length !== 6) { toast('Room code must be 6 characters', 'error'); return; }

  const snap = await db.ref(`rooms/${code}`).once('value');
  if (!snap.exists()) { toast('Room not found', 'error'); return; }

  const room = snap.val();
  if (room.closed) { toast('This room is closed', 'error'); return; }

  // Check max users
  if (room.maxUsers > 0) {
    const usersSnap = await db.ref(`rooms/${code}/users`).once('value');
    const activeCount = Object.values(usersSnap.val() || {}).filter(u => u.online).length;
    if (activeCount >= room.maxUsers) { toast('Room is full', 'error'); return; }
  }

  S.username = name; S.isOwner = false; S.roomCode = code;
  S.roomType = room.type; S.maxUsers = room.maxUsers;
  S.canRead  = false; // default — owner must grant
  sessionStorage.setItem('ec_name', name);

  await db.ref(`rooms/${code}/users/${S.userId}`).set({
    name, online: true, joinedAt: Date.now(), canRead: false,
  });
  db.ref(`rooms/${code}/users/${S.userId}/online`).onDisconnect().set(false);

  enterChat();
}

// ── Enter chat ─────────────────────────────────────────────────────────────────
function enterChat() {
  showScreen('screen-chat');
  $('chat-room-code').textContent = S.roomCode;
  $('room-type-badge').textContent = S.roomType === 'duo' ? '⚡ DUO' : '👥 GROUP';
  $('btn-close-room').classList.toggle('hidden', !S.isOwner);
  $('btn-permissions').classList.toggle('hidden', !S.isOwner);
  listenRoom();
  checkScheduledMessages();
}

// ── Firebase listeners ─────────────────────────────────────────────────────────
function listenRoom() {
  const root = db.ref(`rooms/${S.roomCode}`);

  // Users
  const uRef = root.child('users');
  const uL   = uRef.on('value', snap => {
    const users = snap.val() || {};
    renderUsers(users);
    // Update own canRead from Firebase
    if (users[S.userId]) {
      const wasRead = S.canRead;
      S.canRead = !!users[S.userId].canRead;
      if (!wasRead && S.canRead) toast('✅ Owner granted you read access', 'success');
    }
    // Owner: render permissions panel
    if (S.isOwner) renderPermissionsPanel(users);
  });

  // Messages
  const mRef = root.child('messages');
  const mAdd = mRef.orderByChild('timestamp').on('child_added', (snap) => {
    const d = snap.val(); if (!d) return;
    if (d.scheduledFor && !d.sent) return; // pending scheduled — skip
    renderMessage(snap.key, d);
    markDelivered(snap.key, d);
  });
  const mChg = mRef.on('child_changed', (snap) => {
    const d = snap.val(); if (!d) return;
    if (d.scheduledFor && !d.sent) return;
    // If it just became sent (scheduled msg delivered)
    if (d.sent && !document.getElementById(`msg-${snap.key}`)) {
      renderMessage(snap.key, d);
    }
    updateReceipts(snap.key, d);
  });
  const mDel = mRef.on('child_removed', snap => removeMsgUI(snap.key));

  // Scheduled messages
  const sRef = root.child('scheduled');
  const sAdd = sRef.on('child_added', (snap) => {
    const d = snap.val(); if (!d) return;
    if (d.from === S.userId) scheduleDelivery(snap.key, d);
  });

  // Room closed
  root.child('closed').on('value', snap => {
    if (snap.val() === true && !S.isOwner) forceLeave();
  });

  S.listeners = [
    () => uRef.off('value', uL),
    () => mRef.off('child_added', mAdd),
    () => mRef.off('child_changed', mChg),
    () => mRef.off('child_removed', mDel),
    () => sRef.off('child_added', sAdd),
  ];
}

// ── Render users ───────────────────────────────────────────────────────────────
function renderUsers(users) {
  const list = $('users-list'); list.innerHTML = '';
  let online = 0;
  for (const [uid, u] of Object.entries(users)) {
    if (!u) continue;
    if (u.online) online++;
    const li = ce('li'); li.className = `user-item ${u.online ? 'online' : 'offline'}`;
    li.innerHTML = `
      <div class="user-avatar">${u.name.charAt(0).toUpperCase()}</div>
      <div class="user-meta">
        <span class="user-name">${u.name}${uid === S.userId ? ' <span class="you-tag">YOU</span>' : ''}</span>
        <span class="user-status">${u.online ? 'Online' : 'Offline'}${u.canRead ? ' · 🔓 Read' : ' · 🔒 Encrypted'}</span>
      </div>
    `;
    list.appendChild(li);
  }
  $('online-count').textContent = online;
}

// ── Permissions Panel (owner only) ─────────────────────────────────────────────
function renderPermissionsPanel(users) {
  const panel = $('permissions-list'); if (!panel) return;
  panel.innerHTML = '';
  for (const [uid, u] of Object.entries(users)) {
    if (!u || uid === S.userId) continue;
    const row = ce('div'); row.className = 'perm-row';
    row.innerHTML = `
      <div class="perm-avatar">${u.name.charAt(0).toUpperCase()}</div>
      <span class="perm-name">${u.name}</span>
      <label class="toggle-switch" title="${u.canRead ? 'Revoke read access' : 'Grant read access'}">
        <input type="checkbox" ${u.canRead ? 'checked' : ''} onchange="toggleReadPerm('${uid}', this.checked)">
        <span class="toggle-track"></span>
      </label>
      <span class="perm-status ${u.canRead ? 'granted' : 'denied'}">${u.canRead ? '🔓' : '🔒'}</span>
    `;
    panel.appendChild(row);
  }
}

async function toggleReadPerm(uid, value) {
  await db.ref(`rooms/${S.roomCode}/users/${uid}/canRead`).set(value);
  toast(value ? '🔓 Read access granted' : '🔒 Read access revoked', value ? 'success' : 'info');
}

// ── Send message ───────────────────────────────────────────────────────────────
async function handleSend() {
  const text      = $('msg-input').value.trim();
  const file      = S.pendingFile;
  const timerMs   = parseInt($('destruct-select').value) * 1000;
  const schedTime = S.scheduledTime;
  if (!text && !file) return;

  $('btn-send').disabled = true;

  try {
    if (schedTime) {
      // Store as scheduled message
      const schedRef = db.ref(`rooms/${S.roomCode}/scheduled`).push();
      const msgId    = schedRef.key;
      const enc      = text ? await EmojiCipher.encrypt(text, S.roomCode, msgId) : null;
      await schedRef.set({
        from: S.userId, fromName: S.username,
        timestamp: schedTime, scheduledFor: schedTime, sent: false,
        content: enc, type: 'text', expiresAt: timerMs > 0 ? schedTime + timerMs : null,
      });
      toast(`⏰ Scheduled for ${fmtDateTime(schedTime)}`, 'success');
      clearSchedule();
    } else {
      const msgRef = db.ref(`rooms/${S.roomCode}/messages`).push();
      const msgId  = msgRef.key;

      let msgData = {
        from: S.userId, fromName: S.username,
        timestamp: Date.now(),
        expiresAt: timerMs > 0 ? Date.now() + timerMs : null,
        readBy:    { [S.userId]: Date.now() },
        delivered: { [S.userId]: Date.now() },
        type: 'text',
      };

      if (file) {
        const path   = `rooms/${S.roomCode}/files/${Date.now()}_${file.name}`;
        const snap   = await storage.ref(path).put(file);
        const url    = await snap.ref.getDownloadURL();
        msgData.type     = 'file';
        msgData.fileUrl  = url;
        msgData.fileName = file.name;
        msgData.fileSize = file.size;
        msgData.fileType = file.type;
        clearFilePreview();
      }
      if (text) msgData.content = await EmojiCipher.encrypt(text, S.roomCode, msgId);

      await msgRef.set(msgData);
    }

    $('msg-input').value = '';
    $('msg-input').style.height = 'auto';
  } catch (e) {
    toast('Failed to send', 'error'); console.error(e);
  }
  $('btn-send').disabled = false;
  $('msg-input').focus();
}

// ── Scheduled message delivery ─────────────────────────────────────────────────
function checkScheduledMessages() {
  const now = Date.now();
  db.ref(`rooms/${S.roomCode}/scheduled`).orderByChild('from').equalTo(S.userId).once('value', snap => {
    snap.forEach(child => {
      const d = child.val();
      if (d && !d.sent) scheduleDelivery(child.key, d);
    });
  });
}

function scheduleDelivery(schedId, data) {
  const delay = Math.max(0, data.scheduledFor - Date.now());
  const h = setTimeout(async () => {
    // Move to messages
    const msgRef = db.ref(`rooms/${S.roomCode}/messages`).push();
    const msgId  = msgRef.key;
    let content  = data.content;
    // Re-encrypt with new msgId (since old key was schedId)
    // Actually we stored with schedId as key — decrypt first, re-encrypt with msgId
    if (content) {
      const plain = await EmojiCipher.decrypt(content, S.roomCode, schedId);
      content = await EmojiCipher.encrypt(plain, S.roomCode, msgId);
    }
    await msgRef.set({
      from: data.from, fromName: data.fromName,
      timestamp: Date.now(), expiresAt: data.expiresAt,
      readBy: { [S.userId]: Date.now() },
      delivered: { [S.userId]: Date.now() },
      type: data.type || 'text', content,
      wasScheduled: true,
    });
    await db.ref(`rooms/${S.roomCode}/scheduled/${schedId}`).remove();
    delete S.schedTimers[schedId];
  }, delay);
  S.schedTimers[schedId] = h;
}

// ── File handling ──────────────────────────────────────────────────────────────
function handleFileSelect(e) {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 25 * 1024 * 1024) { toast('Max 25 MB', 'error'); return; }
  S.pendingFile = file;
  $('fp-name').textContent = file.name;
  $('fp-size').textContent = fmtSize(file.size);
  $('file-preview').classList.remove('hidden');
  e.target.value = '';
}
function clearFilePreview() {
  S.pendingFile = null;
  $('file-preview').classList.add('hidden');
}

// ── Schedule UI ────────────────────────────────────────────────────────────────
function toggleScheduler() {
  const panel = $('schedule-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    // Default to 1 hour from now
    const d = new Date(Date.now() + 3600000);
    const pad = n => String(n).padStart(2, '0');
    $('schedule-dt').value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
function applySchedule() {
  const val = $('schedule-dt').value;
  if (!val) { toast('Pick a date/time', 'error'); return; }
  const ts = new Date(val).getTime();
  if (ts <= Date.now()) { toast('Must be a future time', 'error'); return; }
  S.scheduledTime = ts;
  $('schedule-panel').classList.add('hidden');
  $('btn-schedule').classList.add('active');
  $('schedule-label').textContent = fmtDateTime(ts);
  $('active-schedule').classList.remove('hidden');
  toast(`⏰ Scheduled: ${fmtDateTime(ts)}`, 'success');
}
function clearSchedule() {
  S.scheduledTime = null;
  $('btn-schedule').classList.remove('active');
  $('active-schedule').classList.add('hidden');
  $('schedule-panel').classList.add('hidden');
}

// ── Render message ─────────────────────────────────────────────────────────────
function renderMessage(id, data) {
  if (data.expiresAt && Date.now() > data.expiresAt) {
    db.ref(`rooms/${S.roomCode}/messages/${id}`).remove(); return;
  }
  if (document.getElementById(`msg-${id}`)) return; // already rendered

  const isMine = data.from === S.userId;
  const list   = $('messages-list');

  // Remove empty state
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  const wrap = ce('div');
  wrap.id    = `msg-${id}`;
  wrap.className = `msg-wrap ${isMine ? 'mine' : 'theirs'}`;
  wrap.dataset.ts = data.timestamp;

  const initial = data.fromName.charAt(0).toUpperCase();
  const avatarColor = stringToHue(data.fromName);

  // Timer bar
  const timerBar = data.expiresAt
    ? `<div class="destruct-bar" style="--dur:${Math.max(0,data.expiresAt-Date.now())}ms"></div>` : '';

  // Content
  let bodyHTML = '';
  if (data.type === 'file') {
    const isImg = data.fileType?.startsWith('image/');
    bodyHTML = `<div class="msg-file">
      ${isImg ? `<img class="file-img" src="${data.fileUrl}" alt="${data.fileName}" onclick="window.open('${data.fileUrl}','_blank')">` : ''}
      <div class="file-row">
        <span class="file-icon-big">${getFileIcon(data.fileType)}</span>
        <div class="file-meta"><span class="file-name">${data.fileName}</span><span class="file-sz">${fmtSize(data.fileSize||0)}</span></div>
        <a class="dl-btn" href="${data.fileUrl}" download="${data.fileName}" target="_blank">⬇</a>
      </div>
    </div>`;
  }
  if (data.content) {
    const canSeeDecrypt = isMine || S.canRead;
    bodyHTML += `
      <div class="msg-content emoji-encoded" id="mc-${id}" data-id="${id}" data-raw="${encodeURIComponent(data.content)}">${data.content}</div>
      ${canSeeDecrypt ? `<button class="btn-reveal" onclick="toggleReveal('${id}')">👁 Reveal</button>` : '<div class="no-access-hint">🔒 No read access</div>'}
    `;
  }

  // Reactions
  const reactHtml = buildReactionsHTML(id, data.reactions || {});

  wrap.innerHTML = `
    <div class="msg-avatar-wrap" style="--hue:${avatarColor}">${initial}</div>
    <div class="msg-col">
      ${!isMine ? `<span class="msg-sender">${data.fromName}</span>` : ''}
      <div class="msg-bubble">
        ${timerBar}
        ${data.wasScheduled ? '<span class="sched-badge">⏰ Scheduled</span>' : ''}
        ${bodyHTML}
        <div class="msg-footer">
          <span class="msg-time">${fmt(data.timestamp)}</span>
          ${data.expiresAt ? '<span class="bomb-icon">💣</span>' : ''}
          ${isMine ? buildReceiptHTML(data) : ''}
        </div>
      </div>
      ${reactHtml}
      <div class="msg-hover-actions">
        <button class="btn-react" onclick="openReactionPicker('${id}', this)" title="React">😊</button>
      </div>
    </div>
  `;

  // Insert sorted by timestamp
  let inserted = false;
  for (const ex of list.querySelectorAll('.msg-wrap')) {
    if (parseInt(ex.dataset.ts) > data.timestamp) { list.insertBefore(wrap, ex); inserted = true; break; }
  }
  if (!inserted) list.appendChild(wrap);

  // Auto-reveal own messages
  if (isMine || (S.canRead && S.globalReveal)) {
    decryptAndShow(id, data.content);
  }

  markRead(id);
  list.scrollTop = list.scrollHeight;

  // Self-destruct bar animation
  if (data.expiresAt) {
    const bar = wrap.querySelector('.destruct-bar');
    if (bar) requestAnimationFrame(() => bar.classList.add('running'));
    const remaining = Math.max(0, data.expiresAt - Date.now());
    S.timers[id] = setTimeout(() => db.ref(`rooms/${S.roomCode}/messages/${id}`).remove(), remaining);
  }
}

function stringToHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function getFileIcon(t) {
  if (!t) return '📎';
  if (t.startsWith('image/')) return '🖼';
  if (t.startsWith('video/')) return '🎥';
  if (t.startsWith('audio/')) return '🎵';
  if (t.includes('pdf'))      return '📄';
  if (t.includes('zip'))      return '🗜';
  return '📎';
}

// ── Reveal / decrypt ───────────────────────────────────────────────────────────
async function toggleReveal(id) {
  const el = document.getElementById(`mc-${id}`); if (!el) return;
  if (S.revealed.has(id)) {
    S.revealed.delete(id);
    el.textContent = decodeURIComponent(el.dataset.raw || '');
    el.classList.remove('revealed');
    const btn = el.nextElementSibling;
    if (btn?.classList.contains('btn-reveal')) btn.textContent = '👁 Reveal';
  } else {
    await decryptAndShow(id, decodeURIComponent(el.dataset.raw || ''));
  }
}

async function decryptAndShow(id, raw) {
  const el = document.getElementById(`mc-${id}`); if (!el) return;
  el.classList.add('decrypting');
  const plain = await EmojiCipher.decrypt(raw, S.roomCode, id);
  el.classList.remove('decrypting');
  el.textContent = plain;
  el.classList.add('revealed');
  S.revealed.add(id);
  const btn = el.nextElementSibling;
  if (btn?.classList.contains('btn-reveal')) btn.textContent = '🔒 Hide';
}

// ── Receipts ───────────────────────────────────────────────────────────────────
function buildReceiptHTML(data) {
  const others  = u => Object.keys(u || {}).filter(k => k !== S.userId).length;
  const read    = others(data.readBy);
  const dlvrd   = others(data.delivered);
  if (read  > 0) return `<span class="receipt r-read"    title="Read">✓✓</span>`;
  if (dlvrd > 0) return `<span class="receipt r-delivered" title="Delivered">✓✓</span>`;
  return `<span class="receipt r-sent" title="Sent">✓</span>`;
}
async function markDelivered(msgId, data) {
  if (data.from === S.userId) return;
  db.ref(`rooms/${S.roomCode}/messages/${msgId}/delivered/${S.userId}`).set(Date.now()).catch(()=>{});
}
async function markRead(msgId) {
  db.ref(`rooms/${S.roomCode}/messages/${msgId}/readBy/${S.userId}`).set(Date.now()).catch(()=>{});
}
function updateReceipts(id, data) {
  const wrap = document.getElementById(`msg-${id}`); if (!wrap || data.from !== S.userId) return;
  const old  = wrap.querySelector('.receipt');
  if (old) old.outerHTML = buildReceiptHTML(data);
}

// ── Reactions ──────────────────────────────────────────────────────────────────
const REACT_EMOJIS = ['❤️','🔥','😂','😮','👍','🎉','🤯','💯','😢','🚀'];

function buildReactionsHTML(msgId, reactions) {
  if (!reactions || !Object.keys(reactions).length) return `<div class="reactions" id="rx-${msgId}"></div>`;
  let html = `<div class="reactions" id="rx-${msgId}">`;
  for (const [emoji, users] of Object.entries(reactions)) {
    const count = Object.keys(users).length; if (!count) continue;
    const mine  = users[S.userId];
    html += `<button class="reaction-chip ${mine ? 'mine' : ''}" onclick="toggleReaction('${msgId}','${emoji}')" title="React with ${emoji}">${emoji} <span>${count}</span></button>`;
  }
  html += '</div>';
  return html;
}

function openReactionPicker(msgId, btn) {
  closeReactionPicker();
  S.reactionPickerTarget = msgId;
  const picker = ce('div'); picker.className = 'reaction-picker'; picker.id = 'reaction-picker';
  picker.innerHTML = REACT_EMOJIS.map(e =>
    `<button class="rp-emoji" onclick="toggleReaction('${msgId}','${e}');closeReactionPicker()">${e}</button>`
  ).join('');
  // Position near button
  const rect = btn.getBoundingClientRect();
  picker.style.cssText = `position:fixed;top:${rect.top - 60}px;left:${rect.left - 80}px;z-index:9999`;
  document.body.appendChild(picker);
  requestAnimationFrame(() => picker.classList.add('open'));
}
function closeReactionPicker() {
  const p = document.getElementById('reaction-picker');
  if (p) p.remove();
  S.reactionPickerTarget = null;
}

async function toggleReaction(msgId, emoji) {
  const ref = db.ref(`rooms/${S.roomCode}/messages/${msgId}/reactions/${emoji}/${S.userId}`);
  const snap = await ref.once('value');
  if (snap.exists()) await ref.remove();
  else await ref.set(Date.now());
  // Update UI
  const snap2 = await db.ref(`rooms/${S.roomCode}/messages/${msgId}/reactions`).once('value');
  const rxEl  = document.getElementById(`rx-${msgId}`);
  if (rxEl) rxEl.outerHTML = buildReactionsHTML(msgId, snap2.val() || {});
}

// ── Remove message from UI ─────────────────────────────────────────────────────
function removeMsgUI(id) {
  const el = document.getElementById(`msg-${id}`);
  if (el) { el.classList.add('msg-out'); setTimeout(() => el.remove(), 400); }
  if (S.timers[id]) { clearTimeout(S.timers[id]); delete S.timers[id]; }
  S.revealed.delete(id);
}

// ── Leave / close ──────────────────────────────────────────────────────────────
async function leaveRoom() {
  if (!S.roomCode) return;
  cleanup();
  await db.ref(`rooms/${S.roomCode}/users/${S.userId}/online`).set(false);
  S.roomCode = null; S.isOwner = false;
  $('messages-list').innerHTML = '';
  showScreen('screen-landing');
  toast('Left the room', 'info');
}
async function closeRoom() {
  if (!S.isOwner || !S.roomCode) return;
  if (!confirm('Close room and delete all messages permanently?')) return;
  await db.ref(`rooms/${S.roomCode}/closed`).set(true);
  await db.ref(`rooms/${S.roomCode}/messages`).remove();
  await db.ref(`rooms/${S.roomCode}/scheduled`).remove();
  setTimeout(() => db.ref(`rooms/${S.roomCode}`).remove(), 2000);
  cleanup(); S.roomCode = null;
  $('messages-list').innerHTML = '';
  showScreen('screen-landing');
  toast('Room closed', 'info');
}
function forceLeave() {
  cleanup(); S.roomCode = null;
  $('messages-list').innerHTML = '';
  showScreen('screen-landing');
  toast('Room was closed by the owner', 'info');
}
function cleanup() {
  S.listeners.forEach(off => off()); S.listeners = [];
  Object.values(S.timers).forEach(clearTimeout); S.timers = {};
  Object.values(S.schedTimers).forEach(clearTimeout); S.schedTimers = {};
  S.revealed.clear();
}

// ── Chat UI helpers ────────────────────────────────────────────────────────────
function initChat() {
  $('btn-copy-code').addEventListener('click', () => copy(S.roomCode));
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-close-room').addEventListener('click', closeRoom);
  $('btn-send').addEventListener('click', handleSend);
  $('msg-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', handleFileSelect);
  $('btn-clear-file').addEventListener('click', clearFilePreview);
  $('btn-schedule').addEventListener('click', toggleScheduler);
  $('btn-apply-sched').addEventListener('click', applySchedule);
  $('btn-clear-sched').addEventListener('click', clearSchedule);
  $('btn-permissions').addEventListener('click', () => {
    $('permissions-panel').classList.toggle('hidden');
  });
  $('toggle-reveal').addEventListener('change', e => {
    S.globalReveal = e.target.checked;
    if (S.canRead && S.globalReveal) {
      document.querySelectorAll('.msg-content.emoji-encoded:not(.revealed)').forEach(el => {
        const id  = el.dataset.id;
        const raw = decodeURIComponent(el.dataset.raw || '');
        if (id && raw) decryptAndShow(id, raw);
      });
    }
  });
}
