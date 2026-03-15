/**
 * EmojiCipher v2.0 — Rotating Per-Message Cipher
 *
 * Every message gets its OWN shuffled emoji alphabet derived from
 * hash(roomCode + messageId). So 🤣 means "I" in message #1 but "z" in #2.
 * A passive observer can NEVER build a codebook — each message is a new cipher.
 *
 * Encryption: AES-256-GCM  |  Key: PBKDF2-SHA256 from room code
 */

const EmojiCipher = (() => {

  // 256 single-codepoint emojis — one per byte value
  const buildBaseTable = () => {
    const ranges = [
      [0x1F600, 0x1F637], // 56  faces
      [0x1F641, 0x1F644], //  4  more faces
      [0x1F400, 0x1F43E], // 63  animals
      [0x1F330, 0x1F343], // 20  plants
      [0x1F311, 0x1F31E], // 14  moon/sky
      [0x1F300, 0x1F30F], // 16  weather
      [0x1F347, 0x1F37F], // 57  food
      [0x1F380, 0x1F393], // 20  objects
      [0x1F3A0, 0x1F3A5], //  6  activities  → 256 total
    ];
    const t = [];
    for (const [s, e] of ranges)
      for (let cp = s; cp <= e; cp++) t.push(String.fromCodePoint(cp));
    return t;
  };

  const BASE_TABLE = buildBaseTable();

  // Seeded PRNG (mulberry32)
  const seededRng = (seed) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // FNV-1a 32-bit hash
  const hashStr = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };

  // Per-message shuffled table — changes every message
  const getTable = (msgId, roomCode) => {
    const seed  = hashStr((msgId || 'x') + roomCode);
    const rng   = seededRng(seed);
    const table = [...BASE_TABLE];
    for (let i = table.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [table[i], table[j]] = [table[j], table[i]];
    }
    return table;
  };

  const splitGraphemes = (str) => {
    if (typeof Intl !== 'undefined' && Intl.Segmenter)
      return [...new Intl.Segmenter().segment(str)].map(s => s.segment);
    return [...str];
  };

  const bytesToEmoji = (bytes, table) =>
    Array.from(bytes).map(b => table[b & 0xFF]).join('');

  const emojiToBytes = (str, table) => {
    const rev = new Map(table.map((e, i) => [e, i]));
    return new Uint8Array(splitGraphemes(str).map(g => rev.get(g)).filter(v => v !== undefined));
  };

  // PBKDF2 key cache
  const keyCache = new Map();
  const deriveKey = async (roomCode) => {
    const k = roomCode.toUpperCase().trim();
    if (keyCache.has(k)) return keyCache.get(k);
    const raw = new TextEncoder().encode(k);
    const km  = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: new TextEncoder().encode('EmojiCipherV2'), iterations: 100_000, hash: 'SHA-256' },
      km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    keyCache.set(k, key);
    return key;
  };

  const encrypt = async (plaintext, roomCode, msgId = 'x') => {
    if (!plaintext || !roomCode) return '';
    try {
      const key   = await deriveKey(roomCode);
      const iv    = crypto.getRandomValues(new Uint8Array(12));
      const ct    = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
      );
      const table = getTable(msgId, roomCode);
      const out   = new Uint8Array(12 + ct.byteLength);
      out.set(iv); out.set(new Uint8Array(ct), 12);
      return bytesToEmoji(out, table);
    } catch (e) { console.error('encrypt', e); return plaintext; }
  };

  const decrypt = async (emojiStr, roomCode, msgId = 'x') => {
    if (!emojiStr || !roomCode) return '';
    try {
      const table = getTable(msgId, roomCode);
      const bytes = emojiToBytes(emojiStr, table);
      if (bytes.length < 13) return '🔒 [Encrypted]';
      const key = await deriveKey(roomCode);
      const dec  = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)
      );
      return new TextDecoder().decode(dec);
    } catch { return '🔒 [Wrong room key]'; }
  };

  return { encrypt, decrypt };
})();
