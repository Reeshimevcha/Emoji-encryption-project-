/**
 * VoidChat v3.1
 * Changes: permanent schedule + destruct buttons next to attach,
 * session persistence, per-user privacy, session timer, chat download.
 */

firebase.initializeApp(firebaseConfig);
const db      = firebase.database();
const storage = firebase.storage();

const S = {
  userId:       localStorage.getItem('vc_uid') || crypto.randomUUID(),
  username:     null, roomCode: null, roomType: null,
  isOwner:      false, canRead: false, canDownload: false,
  myVisibleTo:  null, roomExpiresAt: null,
  listeners:    [], timers: {}, schedTimers: {},
  sessionInterval: null, revealed: new Set(),
  globalReveal: false, pendingFile: null,
  scheduledTime: null, destructSecs: 0,
  sidebarOpen:  false,
};
localStorage.setItem('vc_uid', S.userId);

// ── Utilities ────────────────────────────────────────────────────────────
const $    = id  => document.getElementById(id);
const ce   = tag => document.createElement(tag);
const fmt  = ts  => new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const fmtDT= ts  => new Date(ts).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const fmtSz= b   => b<1024?`${b}B`:b<1048576?`${(b/1024).toFixed(1)}KB`:`${(b/1048576).toFixed(1)}MB`;
const fmtDur = ms => {
  const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
  if(h>0) return `${h}h ${m%60}m ${s%60}s`;
  if(m>0) return `${m}m ${s%60}s`;
  return `${s}s`;
};
const hue = s => { let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))%360; return h; };
const genCode = () => { const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({length:6},()=>c[Math.floor(Math.random()*c.length)]).join(''); };

function toast(msg, type='info') {
  document.querySelectorAll('.toast').forEach(t=>t.remove());
  const t=ce('div'); t.className=`toast toast-${type}`;
  const icons={success:'✓',error:'✗',info:'i'};
  t.innerHTML=`<span class="t-icon">${icons[type]||'i'}</span><span>${msg}</span>`;
  document.body.appendChild(t);
  requestAnimationFrame(()=>t.classList.add('show'));
  setTimeout(()=>{t.classList.remove('show');setTimeout(()=>t.remove(),350);},3000);
}
function copy(text){ navigator.clipboard.writeText(text).then(()=>toast('Copied!','success')); }
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  const s=$(id); if(s) s.classList.add('active');
}

// ── Boot & Session Restore ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initLanding();
  initChat();
  await tryRestoreSession();
});

async function tryRestoreSession() {
  const saved = JSON.parse(localStorage.getItem('vc_session')||'null');
  if (!saved) return;
  try {
    const snap = await db.ref(`rooms/${saved.roomCode}`).once('value');
    if (!snap.exists() || snap.val().closed) { clearSession(); return; }
    const room = snap.val();
    if (room.expiresAt && Date.now() > room.expiresAt) { clearSession(); return; }
    S.username=saved.username; S.roomCode=saved.roomCode;
    S.roomType=saved.roomType; S.isOwner=saved.isOwner;
    S.canRead=saved.canRead||S.isOwner; S.roomExpiresAt=room.expiresAt||null;
    await db.ref(`rooms/${S.roomCode}/users/${S.userId}`).update({online:true,name:S.username});
    db.ref(`rooms/${S.roomCode}/users/${S.userId}/online`).onDisconnect().set(false);
    enterChat();
    toast('Session restored ✓','success');
  } catch(e){ clearSession(); }
}
function saveSession(){
  localStorage.setItem('vc_session',JSON.stringify({
    username:S.username,roomCode:S.roomCode,
    roomType:S.roomType,isOwner:S.isOwner,canRead:S.canRead
  }));
}
function clearSession(){ localStorage.removeItem('vc_session'); }

// ── Landing Init ─────────────────────────────────────────────────────────
function initLanding() {
  document.querySelectorAll('.type-card').forEach(card=>{
    card.addEventListener('click',()=>{
      document.querySelectorAll('.type-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
      $('group-options').classList.toggle('hidden', card.dataset.type!=='group');
    });
  });
  $('max-unlimited').addEventListener('change',e=>{
    $('max-users-wrap').classList.toggle('hidden',e.target.checked);
  });
  $('btn-create').addEventListener('click',handleCreate);
  $('tab-join-btn').addEventListener('click',()=>switchTab('join'));
  $('tab-create-btn').addEventListener('click',()=>switchTab('create'));
  $('btn-join').addEventListener('click',handleJoin);
}

function switchTab(tab){
  $('tab-create-btn').classList.toggle('active',tab==='create');
  $('tab-join-btn').classList.toggle('active',tab==='join');
  $('panel-create').classList.toggle('hidden',tab!=='create');
  $('panel-join').classList.toggle('hidden',tab!=='join');
}

// ── Create Room ──────────────────────────────────────────────────────────
async function handleCreate(){
  const name=$('username-create').value.trim();
  if(!name){toast('Enter your codename','error');return;}
  const typeCard=document.querySelector('.type-card.selected');
  const type=typeCard?typeCard.dataset.type:'duo';
  const maxUsers=type==='group'?($('max-unlimited').checked?0:parseInt($('max-users-val').value)||0):2;
  const sessionMin=parseInt($('session-duration').value)||0;
  S.username=name;S.isOwner=true;S.roomType=type;S.roomCode=genCode();S.canRead=true;
  const expiresAt=sessionMin>0?Date.now()+sessionMin*60*1000:null;
  S.roomExpiresAt=expiresAt;
  await db.ref(`rooms/${S.roomCode}`).set({type,maxUsers,owner:S.userId,created:Date.now(),expiresAt,closed:false});
  await db.ref(`rooms/${S.roomCode}/users/${S.userId}`).set({name,online:true,joinedAt:Date.now(),canRead:true,canDownload:false,myVisibleTo:null});
  db.ref(`rooms/${S.roomCode}/users/${S.userId}/online`).onDisconnect().set(false);
  saveSession(); enterChat();
}

// ── Join Room ────────────────────────────────────────────────────────────
async function handleJoin(){
  const name=$('username-join').value.trim();
  const code=$('room-code-join').value.trim().toUpperCase();
  if(!name){toast('Enter your codename','error');return;}
  if(code.length!==6){toast('Room code must be 6 characters','error');return;}
  const snap=await db.ref(`rooms/${code}`).once('value');
  if(!snap.exists()){toast('Room not found','error');return;}
  const room=snap.val();
  if(room.closed){toast('Room is closed','error');return;}
  if(room.expiresAt&&Date.now()>room.expiresAt){toast('Room has expired','error');return;}
  if(room.maxUsers>0){
    const usSnap=await db.ref(`rooms/${code}/users`).once('value');
    const online=Object.values(usSnap.val()||{}).filter(u=>u.online).length;
    if(online>=room.maxUsers){toast('Room is full','error');return;}
  }
  S.username=name;S.isOwner=false;S.roomCode=code;
  S.roomType=room.type;S.canRead=false;S.roomExpiresAt=room.expiresAt||null;
  await db.ref(`rooms/${code}/users/${S.userId}`).set({name,online:true,joinedAt:Date.now(),canRead:false,canDownload:false,myVisibleTo:null});
  db.ref(`rooms/${code}/users/${S.userId}/online`).onDisconnect().set(false);
  saveSession(); enterChat();
}

// ── Enter Chat ───────────────────────────────────────────────────────────
function enterChat(){
  showScreen('screen-chat');
  $('chat-room-code').textContent=S.roomCode;
  $('sidebar-room-code').textContent=S.roomCode;
  $('room-type-badge').textContent=S.roomType==='duo'?'⚡ DUO':'◈ GROUP';
  $('btn-close-room').classList.toggle('hidden',!S.isOwner);
  $('btn-permissions').classList.toggle('hidden',!S.isOwner);
  $('btn-my-privacy').classList.remove('hidden');
  listenRoom();
  if(S.roomExpiresAt) startSessionTimer();
}

// ── Firebase Listeners ───────────────────────────────────────────────────
function listenRoom(){
  const root=db.ref(`rooms/${S.roomCode}`);
  const uRef=root.child('users');
  const uL=uRef.on('value',snap=>{
    const users=snap.val()||{};
    renderUsers(users);
    const me=users[S.userId];
    if(me){
      const wasRead=S.canRead;
      S.canRead=!!me.canRead||S.isOwner;
      S.canDownload=!!me.canDownload||S.isOwner;
      S.myVisibleTo=me.myVisibleTo||null;
      if(!wasRead&&S.canRead) toast('✅ Read access granted','success');
      $('btn-download-chat').classList.toggle('hidden',!S.canDownload);
    }
    if(S.isOwner) renderOwnerPermissions(users);
    renderMyPrivacy(users);
  });
  const mRef=root.child('messages');
  const mAdd=mRef.orderByChild('timestamp').on('child_added',snap=>{
    const d=snap.val();if(!d)return;
    renderMessage(snap.key,d); markDelivered(snap.key,d);
  });
  const mChg=mRef.on('child_changed',snap=>{
    const d=snap.val();if(!d)return;
    updateReceipts(snap.key,d); updateReactions(snap.key,d);
  });
  const mDel=mRef.on('child_removed',snap=>removeMsgUI(snap.key));
  const sRef=root.child('scheduled');
  const sAdd=sRef.on('child_added',snap=>{
    const d=snap.val();if(!d||d.from!==S.userId)return;
    scheduleDelivery(snap.key,d);
  });
  root.child('closed').on('value',snap=>{
    if(snap.val()===true&&!S.isOwner) forceLeave('Room was closed by owner');
  });
  S.listeners=[
    ()=>uRef.off('value',uL),
    ()=>mRef.off('child_added',mAdd),
    ()=>mRef.off('child_changed',mChg),
    ()=>mRef.off('child_removed',mDel),
    ()=>sRef.off('child_added',sAdd),
  ];
}

// ── Session Timer ────────────────────────────────────────────────────────
function startSessionTimer(){
  if(S.sessionInterval) clearInterval(S.sessionInterval);
  $('session-timer-wrap').classList.remove('hidden');
  const tick=async()=>{
    const rem=S.roomExpiresAt-Date.now();
    if(rem<=0){
      clearInterval(S.sessionInterval);
      if(S.isOwner){await closeRoom(true);}
      else forceLeave('Session expired');
      return;
    }
    $('session-countdown').textContent=fmtDur(rem);
    $('session-timer-wrap').classList.toggle('expiring',rem<300000);
  };
  tick();
  S.sessionInterval=setInterval(tick,1000);
}

// ── Render Users ─────────────────────────────────────────────────────────
function renderUsers(users){
  const list=$('users-list');list.innerHTML='';
  let online=0;
  for(const [uid,u] of Object.entries(users)){
    if(!u)continue;
    if(u.online)online++;
    const li=ce('li');li.className=`user-item ${u.online?'online':'offline'}`;
    li.innerHTML=`
      <div class="ua" style="--h:${hue(u.name||'?')}">${(u.name||'?').charAt(0).toUpperCase()}</div>
      <div class="um">
        <span class="un">${u.name||'?'}${uid===S.userId?' <span class="you-tag">YOU</span>':''}</span>
        <span class="us">${u.online?'● ONLINE':'○ OFFLINE'} · ${u.canRead?'🔓':'🔒'}</span>
      </div>`;
    list.appendChild(li);
  }
  $('online-count').textContent=online;
}

// ── Owner Permissions ────────────────────────────────────────────────────
function renderOwnerPermissions(users){
  const panel=$('owner-perm-list');if(!panel)return;
  panel.innerHTML='';
  let hasOthers=false;
  for(const [uid,u] of Object.entries(users)){
    if(!u||uid===S.userId)continue;
    hasOthers=true;
    const row=ce('div');row.className='perm-row';
    row.innerHTML=`
      <div class="pa" style="--h:${hue(u.name||'?')}">${(u.name||'?').charAt(0).toUpperCase()}</div>
      <div class="pm">
        <span class="pn">${u.name||'?'}</span>
        <span class="ps ${u.online?'online':'offline'}">${u.online?'● ONLINE':'○ OFFLINE'}</span>
      </div>
      <div class="pt">
        <div class="perm-toggle-row">
          <span class="pt-lbl">Read</span>
          <label class="toggle-switch"><input type="checkbox" ${u.canRead?'checked':''} onchange="setUserPerm('${uid}','canRead',this.checked)"><span class="toggle-track"></span></label>
        </div>
        <div class="perm-toggle-row">
          <span class="pt-lbl">Download</span>
          <label class="toggle-switch"><input type="checkbox" ${u.canDownload?'checked':''} onchange="setUserPerm('${uid}','canDownload',this.checked)"><span class="toggle-track"></span></label>
        </div>
      </div>`;
    panel.appendChild(row);
  }
  if(!hasOthers) panel.innerHTML='<div class="perm-empty">Waiting for users to join…</div>';
}
async function setUserPerm(uid,field,value){
  await db.ref(`rooms/${S.roomCode}/users/${uid}/${field}`).set(value);
  toast(`${field==='canRead'?'Read':'Download'} ${value?'granted':'revoked'}`,'success');
}

// ── My Privacy Panel ─────────────────────────────────────────────────────
function renderMyPrivacy(users){
  const panel=$('my-privacy-list');if(!panel)return;
  panel.innerHTML='';
  for(const [uid,u] of Object.entries(users)){
    if(!u||uid===S.userId)continue;
    const allowed=S.myVisibleTo===null||(Array.isArray(S.myVisibleTo)&&S.myVisibleTo.includes(uid));
    const row=ce('div');row.className='perm-row';
    row.innerHTML=`
      <div class="pa" style="--h:${hue(u.name||'?')}">${(u.name||'?').charAt(0).toUpperCase()}</div>
      <div class="pm">
        <span class="pn">${u.name||'?'}</span>
        <span class="ps ${u.online?'online':'offline'}">${u.online?'● ONLINE':'○ OFFLINE'}</span>
      </div>
      <label class="toggle-switch"><input type="checkbox" ${allowed?'checked':''} onchange="toggleMyVisibility('${uid}',this.checked)"><span class="toggle-track"></span></label>`;
    panel.appendChild(row);
  }
  if(!panel.children.length) panel.innerHTML='<div class="perm-empty">No other users yet…</div>';
}
async function toggleMyVisibility(uid,allow){
  const snap=await db.ref(`rooms/${S.roomCode}/users/${S.userId}/myVisibleTo`).once('value');
  let list=snap.val();
  if(list===null){
    const uSnap=await db.ref(`rooms/${S.roomCode}/users`).once('value');
    list=Object.keys(uSnap.val()||{}).filter(k=>k!==S.userId);
  }
  if(!Array.isArray(list))list=[];
  if(allow){if(!list.includes(uid))list.push(uid);}
  else{list=list.filter(k=>k!==uid);}
  const uSnap=await db.ref(`rooms/${S.roomCode}/users`).once('value');
  const allOthers=Object.keys(uSnap.val()||{}).filter(k=>k!==S.userId);
  const isAll=allOthers.every(k=>list.includes(k));
  S.myVisibleTo=isAll?null:list;
  await db.ref(`rooms/${S.roomCode}/users/${S.userId}/myVisibleTo`).set(isAll?null:list);
  toast(allow?'Message visible to user':'Message hidden from user','info');
}

// ── Schedule Panel ───────────────────────────────────────────────────────
function toggleSchedulePanel(){
  const p=$('schedule-panel'),d=$('destruct-panel');
  const isOpen=!p.classList.contains('hidden');
  closeAllPanels();
  if(!isOpen){
    if(!$('sched-dt').value){
      const n=new Date(Date.now()+3600000);
      const pad=x=>String(x).padStart(2,'0');
      $('sched-dt').value=`${n.getFullYear()}-${pad(n.getMonth()+1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`;
    }
    p.classList.remove('hidden');
    $('btn-schedule').classList.add('btn-active');
  }
}
function toggleDestructPanel(){
  const d=$('destruct-panel');
  const isOpen=!d.classList.contains('hidden');
  closeAllPanels();
  if(!isOpen){ d.classList.remove('hidden'); $('btn-destruct').classList.add('btn-active'); }
}
function closeAllPanels(){
  $('schedule-panel').classList.add('hidden');
  $('destruct-panel').classList.add('hidden');
  $('btn-schedule').classList.remove('btn-active');
  $('btn-destruct').classList.remove('btn-active');
}
function applySchedule(){
  const val=$('sched-dt').value;
  if(!val){toast('Pick a date & time','error');return;}
  const ts=new Date(val).getTime();
  if(ts<=Date.now()){toast('Must be a future time','error');return;}
  S.scheduledTime=ts;
  $('btn-schedule').textContent=`⏰`;
  $('btn-schedule').title=`Scheduled: ${fmtDT(ts)}`;
  $('btn-schedule').classList.add('btn-set');
  closeAllPanels();
  toast(`Scheduled: ${fmtDT(ts)}`,'success');
}
function applyDestruct(){
  const v=parseInt($('destruct-sel').value)||0;
  S.destructSecs=v;
  $('btn-destruct').textContent=v>0?'💣':'💣';
  $('btn-destruct').title=v>0?`Self-destruct: ${v<60?v+'s':v<3600?(v/60)+'m':(v/3600)+'h'}`:'No timer';
  $('btn-destruct').classList.toggle('btn-set',v>0);
  closeAllPanels();
  if(v>0) toast(`Self-destruct: ${v<60?v+'s':v<3600?(v/60)+'m':(v/3600)+'h'}`,'success');
}
function clearSchedule(){S.scheduledTime=null;$('btn-schedule').textContent='⏰';$('btn-schedule').classList.remove('btn-set');$('btn-schedule').title='Schedule message';}
function clearDestruct(){S.destructSecs=0;$('btn-destruct').textContent='💣';$('btn-destruct').classList.remove('btn-set');$('btn-destruct').title='Self-destruct timer';}

// ── Send Message ─────────────────────────────────────────────────────────
async function handleSend(){
  const text=$('msg-input').value.trim();
  const file=S.pendingFile;
  if(!text&&!file)return;
  closeAllPanels();
  $('btn-send').disabled=true;
  try{
    if(S.scheduledTime){
      const schedRef=db.ref(`rooms/${S.roomCode}/scheduled`).push();
      const enc=text?await EmojiCipher.encrypt(text,S.roomCode,schedRef.key):null;
      await schedRef.set({from:S.userId,fromName:S.username,timestamp:S.scheduledTime,scheduledFor:S.scheduledTime,sent:false,content:enc,type:'text',expiresAt:S.destructSecs>0?S.scheduledTime+S.destructSecs*1000:null,visibleTo:S.myVisibleTo});
      toast(`Scheduled: ${fmtDT(S.scheduledTime)}`,'success');
      clearSchedule(); clearDestruct();
    } else {
      const msgRef=db.ref(`rooms/${S.roomCode}/messages`).push();
      const msgId=msgRef.key;
      let data={from:S.userId,fromName:S.username,timestamp:Date.now(),expiresAt:S.destructSecs>0?Date.now()+S.destructSecs*1000:null,readBy:{[S.userId]:Date.now()},delivered:{[S.userId]:Date.now()},type:'text',visibleTo:S.myVisibleTo};
      if(file){
        const path=`rooms/${S.roomCode}/files/${Date.now()}_${file.name}`;
        const snap=await storage.ref(path).put(file);
        data.fileUrl=await snap.ref.getDownloadURL();
        data.fileName=file.name;data.fileSize=file.size;data.fileType=file.type;data.type='file';
        clearFilePreview();
      }
      if(text) data.content=await EmojiCipher.encrypt(text,S.roomCode,msgId);
      await msgRef.set(data);
      clearDestruct();
    }
    $('msg-input').value='';
    $('msg-input').style.height='auto';
  }catch(e){toast('Send failed','error');console.error(e);}
  $('btn-send').disabled=false;
  $('msg-input').focus();
}

// ── Scheduled Delivery ───────────────────────────────────────────────────
function scheduleDelivery(schedId,data){
  const delay=Math.max(0,data.scheduledFor-Date.now());
  S.schedTimers[schedId]=setTimeout(async()=>{
    const msgRef=db.ref(`rooms/${S.roomCode}/messages`).push();
    const msgId=msgRef.key;
    let content=data.content;
    if(content){const plain=await EmojiCipher.decrypt(content,S.roomCode,schedId);content=await EmojiCipher.encrypt(plain,S.roomCode,msgId);}
    await msgRef.set({from:data.from,fromName:data.fromName,timestamp:Date.now(),expiresAt:data.expiresAt,readBy:{[S.userId]:Date.now()},delivered:{[S.userId]:Date.now()},type:data.type||'text',content,wasScheduled:true,visibleTo:data.visibleTo||null});
    await db.ref(`rooms/${S.roomCode}/scheduled/${schedId}`).remove();
    delete S.schedTimers[schedId];
  },delay);
}

// ── File Handling ────────────────────────────────────────────────────────
function handleFileSelect(e){
  const file=e.target.files[0];if(!file)return;
  if(file.size>25*1024*1024){toast('Max 25MB','error');return;}
  S.pendingFile=file;
  $('fp-name').textContent=file.name;$('fp-size').textContent=fmtSz(file.size);
  $('file-preview').classList.remove('hidden');
  e.target.value='';
}
function clearFilePreview(){S.pendingFile=null;$('file-preview').classList.add('hidden');}

// ── Render Message ────────────────────────────────────────────────────────
function renderMessage(id,data){
  if(data.expiresAt&&Date.now()>data.expiresAt){db.ref(`rooms/${S.roomCode}/messages/${id}`).remove();return;}
  if(document.getElementById(`msg-${id}`))return;
  const isMine=data.from===S.userId;
  const canSee=isMine||canViewMessage(data);
  const list=$('messages-list');
  const empty=list.querySelector('.empty-state');if(empty)empty.remove();
  const wrap=ce('div');
  wrap.id=`msg-${id}`;
  wrap.className=`msg-wrap ${isMine?'mine':'theirs'}`;
  wrap.dataset.ts=data.timestamp;
  const timerBar=data.expiresAt?`<div class="destruct-bar" style="--dur:${Math.max(0,data.expiresAt-Date.now())}ms"></div>`:'';
  let bodyHTML='';
  if(data.type==='file'){
    const isImg=data.fileType?.startsWith('image/');
    bodyHTML=`<div class="msg-file">${isImg?`<img class="file-img" src="${data.fileUrl}" alt="${data.fileName}" onclick="window.open('${data.fileUrl}','_blank')" loading="lazy">`:''}
      <div class="file-row"><span class="fib">${getFileIcon(data.fileType)}</span><div class="fim"><span class="fin">${data.fileName}</span><span class="fis">${fmtSz(data.fileSize||0)}</span></div>
      <a class="fdl" href="${data.fileUrl}" download="${data.fileName}" target="_blank">⬇</a></div></div>`;
  }
  if(data.content){
    if(canSee){
      bodyHTML+=`<div class="msg-content" id="mc-${id}" data-id="${id}" data-raw="${encodeURIComponent(data.content)}">${data.content}</div>
      <button class="btn-reveal" onclick="toggleReveal('${id}')">👁 REVEAL</button>`;
    } else if(data.visibleTo&&!data.visibleTo.includes(S.userId)){
      bodyHTML+=`<div class="msg-private">🔒 PRIVATE MESSAGE</div>`;
    } else {
      bodyHTML+=`<div class="msg-private">🔒 NO READ ACCESS</div>`;
    }
  }
  wrap.innerHTML=`
    <div class="ma" style="--h:${hue(data.fromName||'?')}">${(data.fromName||'?').charAt(0).toUpperCase()}</div>
    <div class="mc">
      ${!isMine?`<span class="msender">${data.fromName}</span>`:''}
      <div class="mb">
        ${timerBar}
        ${data.wasScheduled?'<span class="sched-tag-msg">⏰ SCHEDULED</span>':''}
        ${bodyHTML}
        <div class="mf">
          <span class="mt">${fmt(data.timestamp)}</span>
          ${data.expiresAt?'<span class="bomb-tag">💣</span>':''}
          ${isMine?buildReceipt(data):''}
        </div>
      </div>
      <div class="reactions" id="rx-${id}"></div>
      <div class="mha"><button class="btn-react" onclick="openReactionPicker('${id}',this)">+</button></div>
    </div>`;
  let inserted=false;
  for(const ex of list.querySelectorAll('.msg-wrap')){
    if(parseInt(ex.dataset.ts)>data.timestamp){list.insertBefore(wrap,ex);inserted=true;break;}
  }
  if(!inserted) list.appendChild(wrap);
  if(isMine||(S.canRead&&S.globalReveal&&canSee)) decryptAndShow(id,data.content);
  markRead(id);
  list.scrollTop=list.scrollHeight;
  if(data.expiresAt){
    const bar=wrap.querySelector('.destruct-bar');
    if(bar) requestAnimationFrame(()=>bar.classList.add('running'));
    S.timers[id]=setTimeout(()=>db.ref(`rooms/${S.roomCode}/messages/${id}`).remove(),Math.max(0,data.expiresAt-Date.now()));
  }
}

function canViewMessage(data){
  if(data.visibleTo&&!data.visibleTo.includes(S.userId))return false;
  return S.canRead;
}
function getFileIcon(t){
  if(!t)return'📎';if(t.startsWith('image/'))return'🖼';
  if(t.startsWith('video/'))return'🎥';if(t.startsWith('audio/'))return'🎵';
  if(t.includes('pdf'))return'📄';return'📎';
}

// ── Reveal ────────────────────────────────────────────────────────────────
async function toggleReveal(id){
  const el=document.getElementById(`mc-${id}`);if(!el)return;
  if(S.revealed.has(id)){
    S.revealed.delete(id);
    el.textContent=decodeURIComponent(el.dataset.raw||'');
    el.classList.remove('revealed');
    const btn=el.nextElementSibling;
    if(btn?.classList.contains('btn-reveal'))btn.textContent='👁 REVEAL';
  } else {
    await decryptAndShow(id,decodeURIComponent(el.dataset.raw||''));
  }
}
async function decryptAndShow(id,raw){
  const el=document.getElementById(`mc-${id}`);if(!el)return;
  el.classList.add('decrypting');
  const plain=await EmojiCipher.decrypt(raw,S.roomCode,id);
  el.classList.remove('decrypting');
  el.textContent=plain;el.classList.add('revealed');S.revealed.add(id);
  const btn=el.nextElementSibling;
  if(btn?.classList.contains('btn-reveal'))btn.textContent='🔒 HIDE';
}

// ── Receipts ──────────────────────────────────────────────────────────────
function buildReceipt(data){
  const oth=u=>Object.keys(u||{}).filter(k=>k!==S.userId).length;
  const r=oth(data.readBy),d=oth(data.delivered);
  if(r>0)return`<span class="rcpt rcpt-read" title="Read">✓✓</span>`;
  if(d>0)return`<span class="rcpt rcpt-dlvr" title="Delivered">✓✓</span>`;
  return`<span class="rcpt rcpt-sent" title="Sent">✓</span>`;
}
async function markDelivered(msgId,data){
  if(data.from===S.userId)return;
  db.ref(`rooms/${S.roomCode}/messages/${msgId}/delivered/${S.userId}`).set(Date.now()).catch(()=>{});
}
async function markRead(msgId){
  db.ref(`rooms/${S.roomCode}/messages/${msgId}/readBy/${S.userId}`).set(Date.now()).catch(()=>{});
}
function updateReceipts(id,data){
  const w=document.getElementById(`msg-${id}`);if(!w||data.from!==S.userId)return;
  const old=w.querySelector('.rcpt');if(old)old.outerHTML=buildReceipt(data);
}

// ── Reactions ─────────────────────────────────────────────────────────────
const REACTS=['❤️','🔥','😂','😮','👍','🎉','🤯','💯','😢','🚀','⚡','🔐'];
function openReactionPicker(msgId,btn){
  document.querySelectorAll('.reaction-picker').forEach(p=>p.remove());
  const p=ce('div');p.className='reaction-picker';
  p.innerHTML=REACTS.map(e=>`<button class="rpe" onclick="toggleReaction('${msgId}','${e}');this.closest('.reaction-picker').remove()">${e}</button>`).join('');
  const rect=btn.getBoundingClientRect();
  const left=Math.min(rect.left-60,window.innerWidth-220);
  const top=rect.top-70;
  p.style.cssText=`position:fixed;top:${Math.max(10,top)}px;left:${Math.max(10,left)}px;z-index:9999`;
  document.body.appendChild(p);
  requestAnimationFrame(()=>p.classList.add('open'));
}
async function toggleReaction(msgId,emoji){
  const ref=db.ref(`rooms/${S.roomCode}/messages/${msgId}/reactions/${encodeURIComponent(emoji)}/${S.userId}`);
  const snap=await ref.once('value');
  if(snap.exists())await ref.remove();else await ref.set(Date.now());
}
function updateReactions(id,data){
  const el=document.getElementById(`rx-${id}`);if(!el)return;
  let html='';
  for(const [e,users] of Object.entries(data.reactions||{})){
    const count=Object.keys(users).length;if(!count)continue;
    const mine=!!users[S.userId];
    html+=`<button class="rx-chip${mine?' mine':''}" onclick="toggleReaction('${id}','${decodeURIComponent(e)}')">${decodeURIComponent(e)}<span>${count}</span></button>`;
  }
  el.innerHTML=html;
}

// ── Remove Message ────────────────────────────────────────────────────────
function removeMsgUI(id){
  const el=document.getElementById(`msg-${id}`);
  if(el){el.classList.add('msg-out');setTimeout(()=>el.remove(),350);}
  if(S.timers[id]){clearTimeout(S.timers[id]);delete S.timers[id];}
  S.revealed.delete(id);
}

// ── Download Chat ─────────────────────────────────────────────────────────
async function downloadChat(){
  if(!S.canDownload){toast('No download permission','error');return;}
  toast('Preparing download…','info');
  const snap=await db.ref(`rooms/${S.roomCode}/messages`).orderByChild('timestamp').once('value');
  const msgs=[];
  snap.forEach(c=>{const d=c.val();if(d)msgs.push({id:c.key,...d});});
  let rows='';
  for(const m of msgs){
    let text=m.content||'';
    if(text)text=await EmojiCipher.decrypt(text,S.roomCode,m.id);
    if(!text&&m.type==='file')text=`[FILE: ${m.fileName||'attachment'}]`;
    rows+=`<tr><td>${fmt(m.timestamp)}</td><td>${m.fromName||'?'}</td><td>${text}</td></tr>`;
  }
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>VoidChat Transcript — ${S.roomCode}</title>
<style>body{font-family:monospace;background:#000;color:#00ff41;padding:20px;}h1{color:#00d4ff;border-bottom:1px solid #00d4ff;padding-bottom:10px;letter-spacing:4px;}
.meta{color:#444;font-size:12px;margin-bottom:20px;}table{width:100%;border-collapse:collapse;}
th{background:#001400;color:#00ff41;padding:8px;text-align:left;border-bottom:2px solid #00ff41;font-size:11px;letter-spacing:2px;}
td{padding:8px;border-bottom:1px solid #002200;vertical-align:top;}td:first-child{color:#444;white-space:nowrap;width:80px;}
td:nth-child(2){color:#00d4ff;width:100px;font-weight:bold;}td:last-child{color:#90ff90;}</style></head><body>
<h1>🔐 VOIDCHAT TRANSCRIPT</h1>
<div class="meta">CHANNEL: ${S.roomCode} &nbsp;|&nbsp; DOWNLOADED: ${new Date().toLocaleString()} &nbsp;|&nbsp; ${msgs.length} MESSAGES</div>
<table><thead><tr><th>TIME</th><th>OPERATOR</th><th>MESSAGE</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  const blob=new Blob([html],{type:'text/html'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`voidchat-${S.roomCode}-${Date.now()}.html`;
  a.click();
  toast('Chat downloaded!','success');
}

// ── Sidebar ───────────────────────────────────────────────────────────────
function toggleSidebar(){
  S.sidebarOpen=!S.sidebarOpen;
  $('sidebar').classList.toggle('open',S.sidebarOpen);
  $('sidebar-overlay').classList.toggle('active',S.sidebarOpen);
}
function closeSidebar(){
  S.sidebarOpen=false;
  $('sidebar').classList.remove('open');
  $('sidebar-overlay').classList.remove('active');
}

// ── Leave / Close ─────────────────────────────────────────────────────────
async function leaveRoom(){
  if(!S.roomCode)return;
  cleanup();
  await db.ref(`rooms/${S.roomCode}/users/${S.userId}/online`).set(false);
  clearSession();S.roomCode=null;S.isOwner=false;
  $('messages-list').innerHTML='';showScreen('screen-landing');
  toast('Disconnected','info');
}
async function closeRoom(auto=false){
  if(!S.isOwner||!S.roomCode)return;
  if(!auto&&!confirm('Close room and delete all messages permanently?'))return;
  await db.ref(`rooms/${S.roomCode}/closed`).set(true);
  await db.ref(`rooms/${S.roomCode}/messages`).remove();
  await db.ref(`rooms/${S.roomCode}/scheduled`).remove();
  setTimeout(()=>db.ref(`rooms/${S.roomCode}`).remove(),2000);
  cleanup();clearSession();S.roomCode=null;
  $('messages-list').innerHTML='';showScreen('screen-landing');
  if(!auto)toast('Room closed and purged','info');
}
function forceLeave(msg){
  cleanup();clearSession();S.roomCode=null;
  $('messages-list').innerHTML='';showScreen('screen-landing');
  toast(msg||'Room closed','info');
}
function cleanup(){
  S.listeners.forEach(off=>off());S.listeners=[];
  Object.values(S.timers).forEach(clearTimeout);S.timers={};
  Object.values(S.schedTimers).forEach(clearTimeout);S.schedTimers={};
  if(S.sessionInterval){clearInterval(S.sessionInterval);S.sessionInterval=null;}
  S.revealed.clear();
}

// ── Chat UI Init ──────────────────────────────────────────────────────────
function initChat(){
  $('btn-copy-code').addEventListener('click',()=>copy(S.roomCode));
  $('btn-hamburger').addEventListener('click',toggleSidebar);
  $('sidebar-overlay').addEventListener('click',closeSidebar);
  $('btn-leave').addEventListener('click',leaveRoom);
  $('btn-close-room').addEventListener('click',()=>closeRoom(false));
  $('btn-attach').addEventListener('click',()=>$('file-input').click());
  $('file-input').addEventListener('change',handleFileSelect);
  $('btn-clear-file').addEventListener('click',clearFilePreview);
  $('btn-schedule').addEventListener('click',toggleSchedulePanel);
  $('btn-destruct').addEventListener('click',toggleDestructPanel);
  $('btn-apply-schedule').addEventListener('click',applySchedule);
  $('btn-apply-destruct').addEventListener('click',applyDestruct);
  $('btn-permissions').addEventListener('click',()=>{
    $('owner-perm-panel').classList.toggle('hidden');
    $('my-privacy-panel').classList.add('hidden');
  });
  $('btn-my-privacy').addEventListener('click',()=>{
    $('my-privacy-panel').classList.toggle('hidden');
    $('owner-perm-panel').classList.add('hidden');
  });
  $('btn-download-chat').addEventListener('click',downloadChat);
  $('toggle-reveal').addEventListener('change',e=>{
    S.globalReveal=e.target.checked;
    if(S.globalReveal&&S.canRead){
      document.querySelectorAll('.msg-content:not(.revealed)').forEach(el=>{
        const id=el.dataset.id,raw=decodeURIComponent(el.dataset.raw||'');
        if(id&&raw)decryptAndShow(id,raw);
      });
    }
  });
  $('btn-send').addEventListener('click',handleSend);
  $('msg-input').addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();handleSend();}
  });
  document.addEventListener('click',e=>{
    if(!e.target.closest('.reaction-picker')&&!e.target.closest('.btn-react'))
      document.querySelectorAll('.reaction-picker').forEach(p=>p.remove());
    if(!e.target.closest('.input-panel-area')&&!e.target.closest('#schedule-panel')&&!e.target.closest('#destruct-panel'))
      closeAllPanels();
  });
}
