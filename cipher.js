/**
 * VoidChat — EmojiCipher v2.1
 * Rotating per-message AES-256-GCM encryption.
 * Every message uses a unique shuffled emoji alphabet → no codebook possible.
 */
const EmojiCipher = (() => {
  const buildBase = () => {
    const r = [[0x1F600,0x1F637],[0x1F641,0x1F644],[0x1F400,0x1F43E],
               [0x1F330,0x1F343],[0x1F311,0x1F31E],[0x1F300,0x1F30F],
               [0x1F347,0x1F37F],[0x1F380,0x1F393],[0x1F3A0,0x1F3A5]];
    const t = [];
    for (const [s,e] of r) for (let cp=s;cp<=e;cp++) t.push(String.fromCodePoint(cp));
    return t; // 256 entries
  };
  const BASE = buildBase();
  const seededRng = seed => () => {
    seed=(seed+0x6D2B79F5)|0;
    let t=Math.imul(seed^(seed>>>15),1|seed);
    t=(t+Math.imul(t^(t>>>7),61|t))^t;
    return ((t^(t>>>14))>>>0)/4294967296;
  };
  const hash = s => { let h=0x811c9dc5; for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;} return h; };
  const getTable = (msgId,roomCode) => {
    const rng=seededRng(hash((msgId||'x')+roomCode));
    const t=[...BASE];
    for(let i=t.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[t[i],t[j]]=[t[j],t[i]];}
    return t;
  };
  const segs = s => (typeof Intl!=='undefined'&&Intl.Segmenter)?[...new Intl.Segmenter().segment(s)].map(x=>x.segment):[...s];
  const toEmoji = (bytes,t) => Array.from(bytes).map(b=>t[b&0xFF]).join('');
  const fromEmoji = (str,t) => { const m=new Map(t.map((e,i)=>[e,i])); return new Uint8Array(segs(str).map(g=>m.get(g)).filter(v=>v!==undefined)); };
  const keyCache=new Map();
  const deriveKey = async rc => {
    const k=rc.toUpperCase().trim();
    if(keyCache.has(k)) return keyCache.get(k);
    const raw=new TextEncoder().encode(k);
    const km=await crypto.subtle.importKey('raw',raw,'PBKDF2',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey(
      {name:'PBKDF2',salt:new TextEncoder().encode('VoidChatV2'),iterations:100000,hash:'SHA-256'},
      km,{name:'AES-GCM',length:256},false,['encrypt','decrypt']
    );
    keyCache.set(k,key); return key;
  };
  const encrypt = async (plain,rc,msgId='x') => {
    if(!plain||!rc) return '';
    try {
      const key=await deriveKey(rc),iv=crypto.getRandomValues(new Uint8Array(12));
      const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(plain));
      const t=getTable(msgId,rc),out=new Uint8Array(12+ct.byteLength);
      out.set(iv); out.set(new Uint8Array(ct),12);
      return toEmoji(out,t);
    } catch(e){console.error(e);return plain;}
  };
  const decrypt = async (emoji,rc,msgId='x') => {
    if(!emoji||!rc) return '';
    try {
      const t=getTable(msgId,rc),bytes=fromEmoji(emoji,t);
      if(bytes.length<13) return '🔒 [Encrypted]';
      const key=await deriveKey(rc);
      const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},key,bytes.slice(12));
      return new TextDecoder().decode(dec);
    } catch { return '🔒 [Wrong key]'; }
  };
  return {encrypt,decrypt};
})();
