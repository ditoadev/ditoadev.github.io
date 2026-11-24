// Local storage (IndexedDB), end-to-end encryption and sync through a private GitHub repo.
// GitHub only ever receives AES-GCM ciphertext; the passphrase never leaves the device.

// ---------------- IndexedDB ----------------
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open('dayline', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('episodes', { keyPath: 'id' });
      d.createObjectStore('kv');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}
export const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
export const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
export const kvDel = (k) => tx('kv', 'readwrite', (s) => s.delete(k));
export const allEpisodes = async () => (await tx('episodes', 'readonly', (s) => s.getAll())).filter(Boolean);
export const getEpisode = (id) => tx('episodes', 'readonly', (s) => s.get(id));
export const putEpisodeRaw = (ep) => tx('episodes', 'readwrite', (s) => s.put(ep));
export async function saveEpisode(ep) {
  ep.updatedAt = Date.now(); ep.dirty = true;
  await putEpisodeRaw(ep);
  return ep;
}
export async function clearLocal() {
  await tx('episodes', 'readwrite', (s) => s.clear());
  await tx('kv', 'readwrite', (s) => s.clear());
}

export function newId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const r = crypto.getRandomValues(new Uint8Array(3)); const h = [...r].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}-${h}`;
}

// ---------------- Crypto ----------------
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0));

export async function deriveKey(passphrase, saltB64) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(saltB64), iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptJson(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}
export async function decryptJson(key, text) {
  const o = JSON.parse(text);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, key, unb64(o.ct));
  return JSON.parse(dec.decode(pt));
}
const utf8b64 = (s) => b64(enc.encode(s));
const b64utf8 = (s) => dec.decode(unb64(s));

// ---------------- GitHub sync ----------------
export class Sync {
  constructor(cfg) { this.cfg = cfg; this.key = null; this.running = null; }

  async gh(path, opts = {}) {
    const { owner, repo, token } = this.cfg;
    const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`, {
      ...opts,
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
    });
    if (r.status === 404) return null;
    if (r.status === 401) throw new Error('GitHub rejected the token. Check it in Settings.');
    if (r.status === 403) throw new Error('GitHub refused access. The token needs Contents read and write on the data repo.');
    if (!r.ok) throw new Error(`GitHub error ${r.status}`);
    return r.json();
  }
  async getFile(path) { const f = await this.gh(path); return f ? { sha: f.sha, text: b64utf8(f.content) } : null; }
  async putFile(path, text, sha, message) {
    const body = { message, content: utf8b64(text) }; if (sha) body.sha = sha;
    const r = await this.gh(path, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    return r.content.sha;
  }

  async unlock() {
    if (this.key) return this.key;
    const { passphrase } = this.cfg;
    let vault = await this.getFile('vault.json');
    if (!vault) {
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      const key = await deriveKey(passphrase, salt);
      const check = await encryptJson(key, { check: 'dayline' });
      await this.putFile('vault.json', JSON.stringify({ v: 1, salt, check }), null, 'Create Dayline vault');
      this.key = key; return key;
    }
    const v = JSON.parse(vault.text);
    const key = await deriveKey(passphrase, v.salt);
    try { await decryptJson(key, v.check); } catch { throw new Error('Wrong passphrase for this data repo.'); }
    this.key = key; return key;
  }

  // Two-way sync. Remote file per episode: episodes/<id>.json (encrypted). Newest updatedAt wins.
  sync(onProgress) {
    if (this.running) return this.running;
    this.running = this._sync(onProgress).finally(() => { this.running = null; });
    return this.running;
  }
  async _sync(onProgress) {
    const key = await this.unlock();
    const listing = (await this.gh('episodes')) || [];
    const remote = new Map(listing.filter((f) => f.name.endsWith('.json')).map((f) => [f.name.slice(0, -5), f.sha]));
    const local = new Map((await allEpisodes()).map((e) => [e.id, e]));
    let down = 0, up = 0;
    for (const [id, sha] of remote) {
      const le = local.get(id);
      if (le && le.syncedSha === sha) continue;
      onProgress?.(`Downloading ${++down}…`);
      const f = await this.getFile(`episodes/${id}.json`);
      const re = await decryptJson(key, f.text);
      if (le && le.dirty && (le.updatedAt || 0) > (re.updatedAt || 0)) { le.syncedSha = f.sha; await putEpisodeRaw(le); continue; }
      re.syncedSha = f.sha; re.dirty = false;
      await putEpisodeRaw(re); local.set(id, re);
    }
    for (const ep of local.values()) {
      if (!ep.dirty) continue;
      onProgress?.(`Uploading ${++up}…`);
      const { dirty, syncedSha, ...clean } = ep;
      const text = await encryptJson(key, clean);
      ep.syncedSha = await this.putFile(`episodes/${ep.id}.json`, text, remote.get(ep.id) || syncedSha, `Update ${ep.id}`);
      ep.dirty = false;
      await putEpisodeRaw(ep);
    }
    await kvSet('lastSync', Date.now());
    return { down, up };
  }
}

// ---------------- Encrypted file export / import (fallback when GitHub is unreachable) ----------------
export async function exportBundle(passphrase) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(passphrase, salt);
  const eps = (await allEpisodes()).map(({ dirty, syncedSha, ...e }) => e);
  return JSON.stringify({ dayline: 1, salt, data: await encryptJson(key, eps) });
}
export async function importBundle(text, passphrase) {
  const o = JSON.parse(text);
  if (!o.dayline) throw new Error('This is not a Dayline export file.');
  const key = await deriveKey(passphrase, o.salt);
  let eps;
  try { eps = await decryptJson(key, o.data); } catch { throw new Error('Wrong passphrase for this file.'); }
  let n = 0;
  for (const e of eps) {
    const le = await getEpisode(e.id);
    if (le && (le.updatedAt || 0) >= (e.updatedAt || 0)) continue;
    e.dirty = true; await putEpisodeRaw(e); n++;
  }
  return n;
}

// ---------------- Transcript file import (.txt from the capture test, or Teams .vtt) ----------------
export function parseTranscript(text, fileName = '', fileDate = new Date()) {
  const lines = [];
  const day = new Date(fileDate); day.setHours(0, 0, 0, 0);
  const at = (h, m, s) => new Date(day.getTime() + ((+h) * 3600 + (+m) * 60 + (+s || 0)) * 1000);
  if (/^WEBVTT/.test(text.trim())) {
    // Teams VTT: "00:01:02.000 --> 00:01:05.000" then "<v Name>text</v>"
    // Offsets count from the meeting start; the file was saved around the meeting's end.
    const secs = (h, mi, s) => (+h) * 3600 + (+mi) * 60 + (+s);
    const raw = [];
    for (const b of text.split(/\r?\n\r?\n/)) {
      const m = b.match(/(\d+):(\d+):(\d+)[.,]\d+\s+-->\s+(\d+):(\d+):(\d+)/);
      if (!m) continue;
      const body = b.slice(b.indexOf(m[0]) + m[0].length).trim();
      const v = body.match(/<v\s+([^>]+)>([\s\S]*?)(<\/v>|$)/);
      const t = (v ? v[2] : body).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (t) raw.push({ s: secs(m[1], m[2], m[3]), e: secs(m[4], m[5], m[6]), who: v ? v[1].trim() : 'Call', text: t });
    }
    const base = new Date(fileDate).getTime() - (raw.length ? raw[raw.length - 1].e : 0) * 1000;
    for (const r of raw) lines.push({ t: base + r.s * 1000, end: base + r.e * 1000, who: r.who, text: r.text });
  } else {
    // Dayline: "HH:MM:SS  Who: text"
    for (const raw of text.split(/\r?\n/)) {
      const m = raw.match(/^\s*(\d{1,2}):(\d{2}):(\d{2})\s+([^:]{1,40}):\s*(.*)$/);
      if (!m) { if (lines.length && raw.trim()) lines[lines.length - 1].text += ' ' + raw.trim(); continue; }
      const t = at(m[1], m[2], m[3]).getTime();
      lines.push({ t, end: t, who: m[4].trim(), text: m[5].trim() });
    }
  }
  if (!lines.length) throw new Error('No transcript lines found. Expected a Dayline .txt or a Teams .vtt file.');
  // Speaker keys: keep You/Call/S<n>; turn other names into S<n> with a name mapping.
  const names = {}, keyFor = {}; let n = 0;
  for (const l of lines) {
    if (/^(You|Call|S\d+)$/.test(l.who)) continue;
    if (/^Speaker (\d+)$/.test(l.who)) { l.who = 'S' + l.who.split(' ')[1]; continue; }
    if (!keyFor[l.who]) { keyFor[l.who] = 'N' + (++n); names[keyFor[l.who]] = l.who; }
    l.who = keyFor[l.who];
  }
  return { lines, names, title: fileName.replace(/\.(txt|vtt)$/i, '') };
}
