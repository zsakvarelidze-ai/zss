/* ZSS — Personal + Holdings, offline.
 *
 * Everything stays on this device. Records live in IndexedDB, each one sealed with AES-256-GCM
 * under a key derived from the passphrase (PBKDF2-SHA-256, 600,000 rounds). The key exists only in
 * memory while the app is unlocked and is never stored. A backup file is the same sealed records
 * plus the salt, so it opens only with the passphrase it was made with.
 *
 * The two sides are the Claude pages, unchanged, in frames (personal.html, holdings.html). They ask
 * for a database through window.parent.ZSSHOST; each side only ever sees its own branch:
 *   side/personal/<collection>/<doc>   side/holdings/<collection>/<doc>
 */
(() => {
'use strict';
const VERSION = '2026-10-07b';
const ITER = 600000;
const DBNAME = 'zss-app';
const KEEP_SNAPS = 20;
const SIDES = ['personal', 'holdings'];
const LABEL = {personal: 'Personal', holdings: 'Business'};
const PROFILE = 'side/meta/profile/me';
const VIEWS = ['personal', 'holdings', 'docs', 'pw'];
const VLABEL = {docs: 'Documents', pw: 'Passwords'};

if (window.top !== window.self) { document.body.textContent = 'This page cannot be opened inside another page.'; throw new Error('framed'); }

const $ = s => document.querySelector(s);
const te = new TextEncoder(), td = new TextDecoder();
function b64(u8){ let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s){ const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
const rid = () => { const a = crypto.getRandomValues(new Uint8Array(15)); return Array.from(a, x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join(''); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function toast(t){ const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.remove('show'), 3200); }
function ago(iso){
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago'; return Math.round(s / 86400) + ' days ago';
}

/* ---------------- IndexedDB ---------------- */
let idbP = null;
function idb(){
  if (!idbP) idbP = new Promise((res, rej) => {
    const r = indexedDB.open(DBNAME, 2);
    r.onupgradeneeded = ev => { const d = r.result;
      if (ev.oldVersion < 1){ d.createObjectStore('meta'); d.createObjectStore('docs', {keyPath: 'k'}); d.createObjectStore('snaps', {keyPath: 'id'}); }
      if (ev.oldVersion < 2) d.createObjectStore('blobs', {keyPath: 'id'}); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return idbP;
}
async function tx(stores, mode, fn){
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode); let out;
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted'));
    out = fn(t);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const metaGet = async k => { const d = await idb(); return req(d.transaction('meta').objectStore('meta').get(k)); };
const metaSet = (k, v) => tx(['meta'], 'readwrite', t => { t.objectStore('meta').put(v, k); });
const allOf = async store => { const d = await idb(); return req(d.transaction(store).objectStore(store).getAll()); };

/* ---------------- crypto ---------------- */
async function deriveKey(pass, salt, iterations){
  const base = await crypto.subtle.importKey('raw', te.encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
async function seal(key, obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, te.encode(JSON.stringify(obj))));
  return {iv: b64(iv), ct: b64(ct)};
}
async function unseal(key, rec){
  const pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(rec.iv)}, key, unb64(rec.ct));
  return JSON.parse(td.decode(pt));
}
async function newVault(pass){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pass, salt, ITER);
  return {key, vault: {v: 1, created: new Date().toISOString(), kdf: {name: 'PBKDF2', hash: 'SHA-256', iterations: ITER, salt: b64(salt)}, check: await seal(key, {check: 'zss'})}};
}
async function openVault(vault, pass){
  const key = await deriveKey(pass, unb64(vault.kdf.salt), vault.kdf.iterations);
  try { const c = await unseal(key, vault.check); if (c && c.check === 'zss') return key; } catch(e){}
  return null;
}

/* ---------------- state ---------------- */
const S = { key: null, docs: new Map(), recOf: new Map(), chain: Promise.resolve(), dirtyTimer: 0, snappedToday: false,
            lastActive: Date.now(), hiddenAt: 0, idleMin: 10, frames: {}, side: 'personal' };

async function loadAll(){
  S.docs.clear(); S.recOf.clear();
  const recs = await allOf('docs'); let bad = 0;
  for (const r of recs){
    try { const o = await unseal(S.key, r); S.docs.set(o.p, o.d); S.recOf.set(o.p, r.k); } catch(e){ bad++; }
  }
  if (bad) toast(bad + ' record(s) could not be opened and were skipped.');
}

/* ---------------- the database the pages see ---------------- */
const subs = new Set();
let flushQueued = false;
const parentOf = p => p.slice(0, p.lastIndexOf('/'));
const idOf = p => p.slice(p.lastIndexOf('/') + 1);
const SEG = /^(?!\.\.?$)[A-Za-z0-9_\-.~:@+]{1,200}$/;
function checkPath(p, even){
  const s = String(p).split('/');
  if (!s.every(x => SEG.test(x)) || s.length > 16 || (s.length % 2 === 0) !== even) throw new TypeError('bad ' + (even ? 'document' : 'collection') + ' path (' + s.length + ' segments): ' + p);
}
const clone = v => v === undefined ? undefined : structuredClone(v);
function docSnap(p){
  const v = S.docs.get(p);
  return Object.freeze({id: idOf(p), exists: v !== undefined, data: () => clone(v), metadata: {fromCache: false, hasPendingWrites: false}});
}
function runQuery(q){
  const pre = q.col + '/'; let ps = [];
  for (const p of S.docs.keys()) if (p.startsWith(pre) && p.indexOf('/', pre.length) < 0) ps.push(p);
  const val = (p, f) => { const d = S.docs.get(p); return d ? d[f] : undefined; };
  for (const [f, op, v] of q.where){
    ps = ps.filter(p => { const x = val(p, f);
      switch (op){ case '==': return x === v; case '!=': return x !== v; case '<': return x < v; case '<=': return x <= v; case '>': return x > v; case '>=': return x >= v;
        case 'in': return Array.isArray(v) && v.includes(x); case 'not-in': return Array.isArray(v) && !v.includes(x);
        case 'array-contains': return Array.isArray(x) && x.includes(v); default: throw new TypeError('bad operator ' + op); } });
  }
  if (q.order){ const [f, dir] = q.order; ps.sort((a, b) => { const x = val(a, f), y = val(b, f); if (x === y) return 0; if (x === undefined) return 1; if (y === undefined) return -1; return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1); }); }
  else ps.sort((a, b) => idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);
  if (q.lim) ps = ps.slice(0, q.lim);
  return ps;
}
function querySnap(q, prev){
  const ps = runQuery(q), docs = ps.map(docSnap);
  const now = new Map(ps.map((p, i) => [p, JSON.stringify(S.docs.get(p))]));
  const changes = [];
  if (prev){
    let i = 0; for (const [p] of prev) { if (!now.has(p)) changes.push({type: 'removed', doc: Object.freeze({id: idOf(p), exists: true, data: () => JSON.parse(prev.get(p)), metadata: {fromCache: false, hasPendingWrites: false}}), oldIndex: i, newIndex: -1}); i++; }
    const pk = [...prev.keys()];
    ps.forEach((p, j) => { if (!prev.has(p)) changes.push({type: 'added', doc: docs[j], oldIndex: -1, newIndex: j}); else if (prev.get(p) !== now.get(p)) changes.push({type: 'modified', doc: docs[j], oldIndex: pk.indexOf(p), newIndex: j}); });
  } else docs.forEach((d, j) => changes.push({type: 'added', doc: d, oldIndex: -1, newIndex: j}));
  return {snap: Object.freeze({docs, size: docs.length, empty: !docs.length, docChanges: () => changes.slice(), metadata: {fromCache: false, hasPendingWrites: false}}), state: now};
}
function deliver(s){
  try {
    if (s.kind === 'doc'){ const j = JSON.stringify(S.docs.get(s.path)); if (s.last === j && s.sent) return; s.last = j; s.sent = true; s.next(docSnap(s.path)); }
    else { const {snap, state} = querySnap(s.q, s.sent ? s.prev : null); if (s.sent && !snap.docChanges().length) return; s.prev = state; s.sent = true; s.next(snap); }
  } catch(e){ console.error(e); }
}
function flush(){ flushQueued = false; for (const s of [...subs]) deliver(s); }
function queueFlush(){ if (!flushQueued){ flushQueued = true; setTimeout(flush, 0); } }

function persist(p){
  const run = async () => {
    if (!S.key) throw {code: 'revoked', message: 'locked'};
    const v = S.docs.get(p), k = S.recOf.get(p);
    if (v === undefined){ if (k){ await tx(['docs'], 'readwrite', t => { t.objectStore('docs').delete(k); }); S.recOf.delete(p); } }
    else { const nk = k || rid(); const rec = await seal(S.key, {p, d: v, t: Date.now()}); await tx(['docs'], 'readwrite', t => { t.objectStore('docs').put(Object.assign({k: nk}, rec)); }); S.recOf.set(p, nk); }
    markDirty();
  };
  const r = S.chain.then(beforeWrite).then(run);
  S.chain = r.catch(e => { console.error(e); toast('A change could not be saved on this device.'); });
  return r;
}
function merge(a, b){
  const out = Object.assign({}, a);
  for (const [k, v] of Object.entries(b)){
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = merge(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}
const isObj = d => d && typeof d === 'object' && !Array.isArray(d);
function docRef(p, side){
  checkPath(p, true);
  return Object.freeze({
    id: idOf(p), path: p,
    get: async () => docSnap(p),
    set: async d => { if (!isObj(d)) throw {code: 'invalid_argument', message: 'body must be an object'}; S.docs.set(p, clone(d)); queueFlush(); return persist(p); },
    update: async d => { if (!isObj(d)) throw {code: 'invalid_argument', message: 'body must be an object'}; if (!S.docs.has(p)) throw {code: 'invalid_argument', message: 'document does not exist'}; S.docs.set(p, merge(S.docs.get(p), d)); queueFlush(); return persist(p); },
    delete: async () => { if (!S.docs.has(p)) return; S.docs.delete(p); queueFlush(); return persist(p); },
    acquire: async () => ({acquired: true, expiresAt: new Date(Date.now() + 30000).toISOString()}),
    onSnapshot: (next, error) => { const s = {kind: 'doc', path: p, next, error, side}; subs.add(s); setTimeout(() => { if (subs.has(s)) deliver(s); }, 0); return () => subs.delete(s); },
    collection: c => colRef(p + '/' + c, side),
  });
}
function query(col, side, where, order, lim){
  const q = {col, where, order, lim};
  return {
    where: (f, op, v) => query(col, side, where.concat([[f, op, v]]), order, lim),
    orderBy: (f, dir) => query(col, side, where, [f, dir || 'asc'], lim),
    limit: n => query(col, side, where, order, n),
    get: async () => querySnap(q, null).snap,
    onSnapshot: (next, error) => { const s = {kind: 'col', q, next, error, side}; subs.add(s); setTimeout(() => { if (subs.has(s)) deliver(s); }, 0); return () => subs.delete(s); },
  };
}
function colRef(c, side){
  checkPath(c, false);
  return Object.freeze(Object.assign(query(c, side, [], null, 0), {
    path: c,
    doc: id => docRef(c + '/' + (id || rid()), side),
    add: async d => { const r = docRef(c + '/' + rid(), side); await r.set(d); return r; },
  }));
}
function scopedDb(side){
  const base = 'side/' + side + '/';
  return Object.freeze({ collection: p => colRef(base + p, side), doc: p => docRef(base + p, side) });
}
window.ZSSHOST = Object.freeze({
  use: async (side, name) => (name === 'db' && SIDES.includes(side) && S.key) ? scopedDb(side) : null,
  show: side => { if (SIDES.includes(side)) showSide(side); },
  profile: () => clone(S.docs.get(PROFILE)) || {},
  activity: () => { S.lastActive = Date.now(); },
});

/* ---------------- snapshots ---------------- */
async function snapshot(why){
  const recs = await allOf('docs');
  const id = new Date().toISOString() + '-' + rid().slice(0, 4);
  await tx(['snaps'], 'readwrite', t => { t.objectStore('snaps').put({id, why, day: today(), count: recs.length, recs}); });
  const all = (await allOf('snaps')).sort((a, b) => a.id < b.id ? 1 : -1);
  if (all.length > KEEP_SNAPS) await tx(['snaps'], 'readwrite', t => { for (const s of all.slice(KEEP_SNAPS)) t.objectStore('snaps').delete(s.id); });
  return id;
}
async function beforeWrite(){
  if (S.snappedToday) return;
  S.snappedToday = true;
  const all = await allOf('snaps');
  if (!all.some(s => s.day === today() && s.why === 'daily')) await snapshot('daily');
}
async function replaceRecords(recs){
  await tx(['docs'], 'readwrite', t => { const st = t.objectStore('docs'); st.clear(); for (const r of recs) st.put({k: r.k || rid(), iv: r.iv, ct: r.ct}); });
}

/* ---------------- backups ---------------- */
async function buildBackup(){
  await S.chain;
  const vault = await metaGet('vault'), recs = await allOf('docs');
  return JSON.stringify({format: 'zss-backup', v: 1, app: VERSION, created: new Date().toISOString(), kdf: vault.kdf, check: vault.check, count: recs.length, recs: recs.map(r => ({iv: r.iv, ct: r.ct}))});
}
const hasFolderApi = () => typeof window.showDirectoryPicker === 'function';
async function folderBackup(quiet){
  const h = await metaGet('backupDir'); if (!h) return false;
  let perm = 'denied'; try { perm = await h.queryPermission({mode: 'readwrite'}); } catch(e){}
  if (perm !== 'granted'){ S.folderPerm = perm; renderChip(); return false; }
  S.folderPerm = 'granted';
  const data = await buildBackup();
  for (const name of ['zss-backup-latest.json', 'zss-backup-' + today() + '.json']){
    const fh = await h.getFileHandle(name, {create: true}); const w = await fh.createWritable(); await w.write(data); await w.close();
  }
  await metaSet('lastBackup', new Date().toISOString());
  try { await blobsToFolder(h); } catch(e){ console.error(e); }
  renderChip(); if (!quiet) toast('Backed up to your folder.');
  return true;
}
function markDirty(){
  clearTimeout(S.dirtyTimer);
  S.dirtyTimer = setTimeout(() => folderBackup(true).catch(e => { console.error(e); S.folderPerm = 'error'; renderChip(); }), 20000);
}
function saveFile(name, text){
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function exportFile(){
  saveFile('zss-backup-' + today() + '.json', await buildBackup());
  await metaSet('lastExport', new Date().toISOString()); await metaSet('lastBackup', new Date().toISOString());
  renderChip(); renderSettings();
}
async function readBackup(file, pass){
  let j; try { j = JSON.parse(await file.text()); } catch(e){ throw new Error('That file is not a ZSS backup.'); }
  if (!j || j.format !== 'zss-backup' || !j.kdf || !j.check || !Array.isArray(j.recs)) throw new Error('That file is not a ZSS backup.');
  const key = await openVault(j, pass);
  if (!key) throw new Error('Wrong passphrase for that backup.');
  const items = [];
  for (const r of j.recs){ const o = await unseal(key, r); if (o && typeof o.p === 'string' && isObj(o.d)) items.push(o); }
  return {j, key, items};
}

/* ---------------- lock / unlock ---------------- */
async function lock(why){
  if (!S.key) return;
  try { await S.chain; } catch(e){}
  clearTimeout(S.dirtyTimer);
  try { await folderBackup(true); } catch(e){}
  pwLock(); closeViewers();
  S.key = null; S.docs.clear(); S.recOf.clear(); subs.clear();
  for (const s of SIDES){ if (S.frames[s]){ S.frames[s].remove(); delete S.frames[s]; } }
  if ($('#dlg').open) $('#dlg').close();
  showGate('unlock');
  if (why) $('#u-msg').textContent = why;
}
async function enter(){
  S.lastActive = Date.now(); S.snappedToday = false;
  S.idleMin = (await metaGet('idleMin')) || 10;
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch(e){}
  $('#gate').hidden = true; $('#app').hidden = false;
  gcBlobs().catch(e => console.error(e));
  let start = 'personal'; try { const v = localStorage.getItem('zss-app-side'); if (VIEWS.includes(v) && v !== 'pw') start = v; } catch(e){}
  showSide(start);
  const h = await metaGet('backupDir');
  if (h){ try { S.folderPerm = await h.queryPermission({mode: 'readwrite'}); if (S.folderPerm === 'prompt') S.folderPerm = await h.requestPermission({mode: 'readwrite'}); } catch(e){ S.folderPerm = 'error'; } }
  renderChip();
}
function busy(form, on){ form.querySelectorAll('button').forEach(b => b.disabled = on); }
let fails = 0;
$('#f-unlock').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.currentTarget, msg = $('#u-msg');
  if (fails >= 5){ const wait = (fails - 4) * 30; msg.className = 'msg err'; msg.textContent = 'Too many tries. Wait ' + wait + ' seconds.'; busy(f, true); await sleep(wait * 1000); busy(f, false); }
  busy(f, true); msg.className = 'msg'; msg.textContent = 'Opening…';
  const vault = await metaGet('vault'); const key = await openVault(vault, $('#u-pass').value);
  busy(f, false);
  if (!key){ fails++; msg.className = 'msg err'; msg.textContent = 'That passphrase does not open this device.'; $('#u-pass').select(); return; }
  fails = 0; $('#u-pass').value = ''; msg.textContent = '';
  S.key = key; await loadAll(); await enter();
});
function strength(p){ let s = Math.min(p.length, 24) / 24; if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s += .1; if (/\d/.test(p)) s += .05; if (/[^A-Za-z0-9]/.test(p)) s += .05; if (/\s/.test(p.trim())) s += .1; return Math.min(1, s); }
$('#n-pass').addEventListener('input', e => { const s = strength(e.target.value); const m = $('#n-meter'); m.style.width = Math.round(s * 100) + '%'; m.style.background = s < .5 ? 'var(--crit)' : s < .8 ? 'var(--warn)' : 'var(--good)'; });
$('#f-new').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.currentTarget, msg = $('#n-msg'), p = $('#n-pass').value;
  if (p.length < 12){ msg.className = 'msg err'; msg.textContent = 'At least 12 characters, please.'; return; }
  if (p !== $('#n-pass2').value){ msg.className = 'msg err'; msg.textContent = 'The two don’t match.'; return; }
  busy(f, true); msg.className = 'msg'; msg.textContent = 'Setting up…';
  const {key, vault} = await newVault(p);
  await tx(['meta', 'docs', 'snaps'], 'readwrite', t => { t.objectStore('docs').clear(); t.objectStore('snaps').clear(); t.objectStore('meta').put(vault, 'vault'); });
  busy(f, false); f.reset(); msg.textContent = '';
  S.key = key; await loadAll(); await enter();
  toast('Done. Open Settings to choose a backup folder.');
});
$('#f-restore').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.currentTarget, msg = $('#r-msg');
  const file = $('#r-file').files[0]; if (!file) return;
  busy(f, true); msg.className = 'msg'; msg.textContent = 'Opening the backup…';
  try {
    const {j, key, items} = await readBackup(file, $('#r-pass').value);
    const hadVault = !!(await metaGet('vault'));
    if (hadVault && S.key){
      // restoring into an unlocked device: keep this device's passphrase, re-seal everything with it
      await S.chain; await snapshot('before restore');
      const recs = []; for (const o of items) recs.push(Object.assign({k: rid()}, await seal(S.key, {p: o.p, d: o.d, t: Date.now()})));
      await replaceRecords(recs);
      await loadAll(); rebuildFrames(); $('#gate').hidden = true; $('#app').hidden = false;
    } else {
      // a new (or erased) device takes the backup's passphrase
      await tx(['meta', 'docs', 'snaps'], 'readwrite', t => { t.objectStore('docs').clear(); t.objectStore('snaps').clear(); t.objectStore('meta').put({v: 1, created: new Date().toISOString(), kdf: j.kdf, check: j.check}, 'vault'); });
      await replaceRecords(j.recs.map(r => ({iv: r.iv, ct: r.ct})));
      S.key = key; await loadAll(); await enter();
    }
    f.reset(); msg.textContent = '';
    toast('Restored ' + items.length + ' records.');
  } catch(err){ msg.className = 'msg err'; msg.textContent = err.message || String(err); }
  busy(f, false);
});

/* ---------------- gate screens ---------------- */
function showGate(which){
  $('#app').hidden = true; $('#gate').hidden = false;
  for (const id of ['g-unlock', 'g-setup', 'f-new', 'f-restore']) $('#' + id).hidden = true;
  const map = {unlock: 'g-unlock', setup: 'g-setup', new: 'f-new', restore: 'f-restore'};
  $('#' + map[which]).hidden = false;
  showGate.cur = which;
  const first = $('#' + map[which]).querySelector('input'); if (first) setTimeout(() => first.focus(), 50);
}

/* ---------------- the two sides ---------------- */
function make(side){
  const fr = document.createElement('iframe');
  fr.title = LABEL[side];
  fr.src = side + '.html?v=' + VERSION;
  fr.addEventListener('load', () => {
    try { const d = fr.contentDocument; ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => d.addEventListener(ev, () => { S.lastActive = Date.now(); }, {passive: true, capture: true})); } catch(e){}
  });
  $('#stage').appendChild(fr);
  return fr;
}
function showSide(side){
  if (S.side === 'pw' && side !== 'pw') pwLock();
  S.side = side;
  if (SIDES.includes(side) && !S.frames[side]) S.frames[side] = make(side);
  for (const s of SIDES) if (S.frames[s]) S.frames[s].hidden = (s !== side);
  $('#v-docs').hidden = side !== 'docs'; $('#v-pw').hidden = side !== 'pw';
  if (side === 'docs') renderDocs();
  if (side === 'pw') renderPw();
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.side === side)));
  document.title = 'ZSS · ' + (LABEL[side] || VLABEL[side]);
  try { localStorage.setItem('zss-app-side', side); } catch(e){}
}
function rebuildFrames(){
  for (const s of [...subs]) if (SIDES.includes(s.side)) subs.delete(s);
  for (const s of SIDES){ if (S.frames[s]){ S.frames[s].remove(); delete S.frames[s]; } }
  showSide(S.side);
}
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => showSide(b.dataset.side)));

/* ---------------- backup chip + settings ---------------- */
async function renderChip(){
  const chip = $('#bk-chip'); const last = await metaGet('lastBackup'); const h = await metaGet('backupDir');
  chip.className = 'chip';
  if (h && S.folderPerm && S.folderPerm !== 'granted'){ chip.classList.add('warn'); chip.textContent = 'Backup folder needs OK'; return; }
  if (!last){ chip.classList.add('warn'); chip.textContent = 'No backup yet'; return; }
  const days = (Date.now() - Date.parse(last)) / 864e5;
  chip.classList.add(days > 7 ? 'crit' : days > 2 ? 'warn' : 'good');
  chip.textContent = 'Backed up ' + ago(last);
}
async function renderSettings(){
  $('#s-last').textContent = ago(await metaGet('lastBackup'));
  const h = await metaGet('backupDir');
  $('#s-folder-wrap').hidden = !hasFolderApi(); $('#s-nofolder').hidden = hasFolderApi();
  $('#s-folder').textContent = h ? h.name + (S.folderPerm === 'granted' ? '' : ' (needs OK)') : 'not chosen';
  $('#b-perm').hidden = !(h && S.folderPerm !== 'granted');
  const snaps = (await allOf('snaps')).sort((a, b) => a.id < b.id ? 1 : -1);
  const ul = $('#s-snaps'); ul.textContent = '';
  if (!snaps.length){ const li = document.createElement('li'); li.textContent = 'None yet'; li.className = 'muted'; ul.appendChild(li); }
  for (const s of snaps){
    const li = document.createElement('li');
    const t = document.createElement('span'); t.textContent = new Date(s.id.slice(0, 24)).toLocaleString() + ' · ' + s.why + ' · ' + s.count + ' records';
    const b = document.createElement('button'); b.className = 'btn'; b.type = 'button'; b.textContent = 'Restore'; b.dataset.snap = s.id;
    li.append(t, b); ul.appendChild(li);
  }
  $('#s-idle').value = String(S.idleMin);
  const pr = S.docs.get(PROFILE) || {}; $('#p-name').value = pr.name || ''; $('#p-about').value = pr.about || '';
  let ps = ''; try { if (navigator.storage){ const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false; const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    ps = (persisted ? 'The browser has agreed to keep this storage.' : 'The browser may clear this storage if the device runs low on space; keep backups.') + (est ? ' Using ' + Math.round(est.usage / 1024) + ' KB.' : ''); } } catch(e){}
  $('#s-persist').textContent = ps;
  await renderFilesSettings();
  $('#s-ver').textContent = 'Version ' + VERSION + ' · ' + S.docs.size + ' records on this device';
}
$('#s-idle').addEventListener('change', async e => { S.idleMin = +e.target.value; await metaSet('idleMin', S.idleMin); toast('Locks after ' + S.idleMin + ' minutes idle.'); });
$('#s-snaps').addEventListener('click', async e => {
  const id = e.target.dataset && e.target.dataset.snap; if (!id) return;
  if (!confirm('Put everything back the way it was at that snapshot? What you have now is saved as a snapshot first.')) return;
  await S.chain; const s = (await allOf('snaps')).find(x => x.id === id); if (!s) return;
  await snapshot('before restore'); await replaceRecords(s.recs); await loadAll(); rebuildFrames(); renderSettings(); toast('Snapshot restored.');
});
$('#f-chpass').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.currentTarget, msg = $('#c-msg');
  const np = $('#c-new').value;
  if (np.length < 12){ msg.className = 'msg err'; msg.textContent = 'At least 12 characters.'; return; }
  if (np !== $('#c-new2').value){ msg.className = 'msg err'; msg.textContent = 'The new ones don’t match.'; return; }
  busy(f, true); msg.className = 'msg'; msg.textContent = 'Checking…';
  try {
    const oldKey = await openVault(await metaGet('vault'), $('#c-old').value);
    if (!oldKey){ msg.className = 'msg err'; msg.textContent = 'Current passphrase is wrong.'; return; }
    await S.chain; msg.textContent = 'Re-locking every record…';
    const {key, vault} = await newVault(np);
    const docs = []; for (const [p, d] of S.docs) docs.push(Object.assign({k: S.recOf.get(p) || rid()}, await seal(key, {p, d, t: Date.now()})));
    const snaps = [];
    for (const s of await allOf('snaps')){ const recs = []; for (const r of s.recs){ try { recs.push(Object.assign({k: r.k}, await seal(key, await unseal(oldKey, r)))); } catch(err){} } snaps.push(Object.assign({}, s, {recs, count: recs.length})); }
    await tx(['meta', 'docs', 'snaps'], 'readwrite', t => { const d = t.objectStore('docs'), sn = t.objectStore('snaps'); d.clear(); docs.forEach(r => d.put(r)); sn.clear(); snaps.forEach(s => sn.put(s)); t.objectStore('meta').put(vault, 'vault'); });
    S.key = key; f.reset(); f.hidden = true; msg.textContent = '';
    toast('Passphrase changed. Make a new backup file: old ones still use the old passphrase.');
    markDirty();
  } finally { busy(f, false); }
});

/* ---------------- actions ---------------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  try {
    if (act === 'show-new') showGate('new');
    else if (act === 'restore-new') showGate('restore');
    else if (act === 'back') showGate((await metaGet('vault')) ? 'unlock' : 'setup');
    else if (act === 'lock') lock();
    else if (act === 'settings'){ await renderSettings(); $('#dlg').showModal(); }
    else if (act === 'close') $('#dlg').close();
    else if (act === 'export') await exportFile();
    else if (act === 'restore'){ $('#dlg').close(); showGateOverlayRestore(); }
    else if (act === 'snap'){ await S.chain; await snapshot('by hand'); renderSettings(); toast('Snapshot taken.'); }
    else if (act === 'folder'){
      const h = await window.showDirectoryPicker({id: 'zss-backup', mode: 'readwrite', startIn: 'documents'});
      await metaSet('backupDir', h); S.folderPerm = 'granted'; await folderBackup(false); renderSettings();
    }
    else if (act === 'folder-perm'){ const h = await metaGet('backupDir'); if (h){ S.folderPerm = await h.requestPermission({mode: 'readwrite'}); if (S.folderPerm === 'granted') await folderBackup(false); renderSettings(); renderChip(); } }
    else if (act === 'chpass'){ const f = $('#f-chpass'); f.hidden = !f.hidden; if (!f.hidden) $('#c-old').focus(); }
    else if (act === 'profile'){
      const d = {name: $('#p-name').value.trim(), about: $('#p-about').value.trim()};
      await docRef(PROFILE).set(d); $('#p-msg').textContent = 'Saved.'; rebuildFrames();
    }
    else if (act === 'erase'){
      const t = prompt('This deletes every record, snapshot and setting on this device. Backup files are not touched.\n\nType ERASE to go ahead.');
      if (t !== 'ERASE') return;
      S.key = null; S.docs.clear(); subs.clear();
      for (const s of SIDES){ if (S.frames[s]){ S.frames[s].remove(); delete S.frames[s]; } }
      pwLock(); closeViewers();
      await tx(['meta', 'docs', 'snaps', 'blobs'], 'readwrite', t2 => { ['meta', 'docs', 'snaps', 'blobs'].forEach(n => t2.objectStore(n).clear()); });
      if ($('#dlg').open) $('#dlg').close();
      showGate('setup'); toast('This device is empty.');
    }
  } catch(err){ if (err && err.name === 'AbortError') return; console.error(err); toast(err.message || 'That did not work.'); }
});
function showGateOverlayRestore(){
  // restore while unlocked: same form, records are re-sealed with this device's passphrase
  $('#app').hidden = true; showGate('restore');
  $('#f-restore').querySelector('[data-act="back"]').onclick = ev => { ev.stopPropagation(); $('#gate').hidden = true; $('#app').hidden = false; $('#f-restore').querySelector('[data-act="back"]').onclick = null; };
}
$('#bk-chip').addEventListener('click', async e => {
  const h = await metaGet('backupDir');
  if (h && S.folderPerm && S.folderPerm !== 'granted'){ e.stopPropagation(); try { S.folderPerm = await h.requestPermission({mode: 'readwrite'}); if (S.folderPerm === 'granted') await folderBackup(false); } catch(err){} renderChip(); }
}, true);

/* ---------------- idle lock ---------------- */
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { S.lastActive = Date.now(); }, {passive: true, capture: true}));
setInterval(() => { if (S.key && Date.now() - S.lastActive > S.idleMin * 60000) lock('Locked after ' + S.idleMin + ' minutes without use.'); }, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') S.hiddenAt = Date.now();
  else if (S.key && S.hiddenAt && Date.now() - S.hiddenAt > S.idleMin * 60000) lock('Locked while you were away.');
});
setInterval(() => { if (S.key) renderChip(); }, 60000);

/* ================= documents & photos =================
 * Each file is encrypted with its own random key (AES-256-GCM). The file's key, name, type and a small
 * preview live in an ordinary record (side/files/items/<id>), sealed with the app key like every other
 * record; the encrypted bytes live in the 'blobs' store. So a backup of the bytes alone opens nothing,
 * and changing the passphrase never has to touch the files themselves.
 */
const FILES = 'side/files/items';
const CATS = [['id', 'ID & licenses'], ['insurance', 'Insurance'], ['vehicle', 'Vehicle'], ['tax', 'Tax'], ['bank', 'Bank & cards'],
  ['medical', 'Medical'], ['property', 'Home & property'], ['business', 'Business papers'], ['receipt', 'Receipts'], ['photo', 'Photos'], ['other', 'Other']];
const CATN = Object.fromEntries(CATS);
const MAXFILE = 200 * 1024 * 1024;
const D = { side: 'all', cat: '', q: '', open: null, url: null };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const kb = n => n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const fileDocs = () => [...S.docs.entries()].filter(([p]) => p.startsWith(FILES + '/')).map(([p, d]) => Object.assign({id: idOf(p)}, d));
const blobGet = async id => { const d = await idb(); return req(d.transaction('blobs').objectStore('blobs').get(id)); };
const blobKeys = async () => { const d = await idb(); return req(d.transaction('blobs').objectStore('blobs').getAllKeys()); };

async function thumbOf(file){
  if (!/^image\//.test(file.type)) return '';
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
    return c.toDataURL('image/jpeg', 0.72);
  } catch(e){ return ''; }
}
async function addFiles(list){
  if (!S.key) return;
  const side = D.side === 'all' ? 'personal' : D.side;
  let n = 0;
  for (const file of list){
    if (file.size > MAXFILE){ toast(file.name + ' is over 200 MB and was skipped.'); continue; }
    toast('Encrypting ' + file.name + '…');
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const fk = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, fk, await file.arrayBuffer());
    const id = rid();
    await tx(['blobs'], 'readwrite', t => { t.objectStore('blobs').put({id, iv: b64(iv), ct}); });
    const cat = /^image\//.test(file.type) ? 'photo' : (D.cat || 'other');
    await docRef(FILES + '/' + id).set({side, name: file.name || ('Photo ' + new Date().toLocaleString()), type: file.type || 'application/octet-stream',
      size: file.size, cat, note: '', added: new Date().toISOString(), fkey: b64(raw), thumb: await thumbOf(file)});
    n++;
  }
  if (n) toast(n === 1 ? 'Added, encrypted.' : n + ' files added, encrypted.');
  renderDocs();
}
async function fileBytes(meta){
  const rec = await blobGet(meta.id);
  if (!rec) throw new Error('This file is not on this device yet. Restore your documents backup.');
  const fk = await crypto.subtle.importKey('raw', unb64(meta.fkey), 'AES-GCM', false, ['decrypt']);
  return new Blob([await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(rec.iv)}, fk, rec.ct)], {type: meta.type});
}
function closeViewers(){
  const dv = $('#dv'); if (dv && dv.open) dv.close();
  const pd = $('#pwd'); if (pd && pd.open) pd.close();
  if (D.url){ URL.revokeObjectURL(D.url); D.url = null; }
  D.open = null; const pv = $('#dv-prev'); if (pv) pv.textContent = '';
}
async function renderDocs(){
  if ($('#v-docs').hidden || !S.key) return;
  const have = new Set(await blobKeys());
  const all = fileDocs();
  const q = D.q.trim().toLowerCase();
  const shown = all.filter(f => (D.side === 'all' || f.side === D.side) && (!D.cat || f.cat === D.cat) && (!q || (f.name + ' ' + (f.note || '') + ' ' + (CATN[f.cat] || '')).toLowerCase().includes(q)))
    .sort((a, b) => (b.added || '').localeCompare(a.added || ''));
  document.querySelectorAll('#d-side button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === D.side)));
  const missing = all.filter(f => !have.has(f.id)).length;
  const total = all.reduce((t, f) => t + (f.size || 0), 0);
  $('#d-sum').textContent = all.length ? (all.length + ' file' + (all.length === 1 ? '' : 's') + ' · ' + kb(total) + (shown.length !== all.length ? ' · showing ' + shown.length : '')) : '';
  $('#d-missing').hidden = !missing; $('#d-missing-n').textContent = missing + ' file' + (missing === 1 ? ' is' : 's are');
  const g = $('#d-grid');
  if (!shown.length){ g.innerHTML = '<p class="empty">' + (all.length ? 'Nothing matches.' : 'No documents yet. Add scans, PDFs or photos: IDs, titles, insurance cards, receipts.') + '</p>'; return; }
  g.innerHTML = shown.map(f => {
    const ext = (f.name.split('.').pop() || '').slice(0, 4).toUpperCase();
    const pic = f.thumb ? '<img alt="" src="' + esc(f.thumb) + '">' : '<span class="ext">' + esc(/pdf/.test(f.type) ? 'PDF' : ext || 'FILE') + '</span>';
    return '<button type="button" class="dcard" data-file="' + esc(f.id) + '"><span class="dthumb">' + pic + '</span><span class="dmeta"><b>' + esc(f.name) + '</b>'
      + '<span class="muted">' + esc(CATN[f.cat] || 'Other') + ' · ' + (f.side === 'holdings' ? 'Business' : 'Personal') + ' · ' + kb(f.size || 0) + (have.has(f.id) ? '' : ' · <em>not on this device</em>') + '</span></span></button>';
  }).join('');
}
async function openFile(id){
  const p = FILES + '/' + id, f = S.docs.get(p); if (!f) return;
  closeViewers(); D.open = id;
  $('#dv-name').value = f.name || ''; $('#dv-side').value = f.side || 'personal'; $('#dv-cat').value = f.cat || 'other';
  $('#dv-date').value = f.date || ''; $('#dv-note').value = f.note || '';
  $('#dv-info').textContent = (f.type || '') + ' · ' + kb(f.size || 0) + ' · added ' + new Date(f.added).toLocaleDateString();
  const pv = $('#dv-prev'); pv.textContent = 'Opening…';
  $('#dv').showModal();
  try {
    const blob = await fileBytes(Object.assign({id}, f)); if (D.open !== id) return;
    D.url = URL.createObjectURL(blob); pv.textContent = '';
    if (/^image\//.test(f.type)){ const im = document.createElement('img'); im.src = D.url; im.alt = f.name; pv.appendChild(im); }
    else { const s = document.createElement('p'); s.className = 'muted'; s.textContent = 'No preview here. Use Open to view it.'; pv.appendChild(s); }
  } catch(e){ pv.textContent = e.message || 'Could not open this file.'; }
}
async function gcBlobs(){
  // a blob no record points to is kept 30 days (a snapshot restore may bring its record back), then removed
  const live = new Set(fileDocs().map(f => f.id));
  const d = await idb();
  const recs = await new Promise((res, rej) => { const out = []; const c = d.transaction('blobs').objectStore('blobs').openCursor();
    c.onsuccess = () => { const cur = c.result; if (!cur) return res(out); const v = cur.value; out.push({id: v.id, del: v.del}); cur.continue(); }; c.onerror = () => rej(c.error); });
  const now = Date.now(), toMark = [], toUnmark = [], toDrop = [];
  for (const r of recs){
    if (live.has(r.id)){ if (r.del) toUnmark.push(r.id); }
    else if (!r.del) toMark.push(r.id);
    else if (now - r.del > 30 * 864e5) toDrop.push(r.id);
  }
  if (!toMark.length && !toUnmark.length && !toDrop.length) return;
  for (const id of toMark.concat(toUnmark)){ const r = await blobGet(id); if (r){ if (toMark.includes(id)) r.del = now; else delete r.del; await tx(['blobs'], 'readwrite', t => { t.objectStore('blobs').put(r); }); } }
  if (toDrop.length) await tx(['blobs'], 'readwrite', t => { toDrop.forEach(id => t.objectStore('blobs').delete(id)); });
}
// documents backup: one container file (works everywhere) and, with a backup folder, one file per document
const MAGIC_C = te.encode('ZSSF1'), MAGIC_B = te.encode('ZSSB1');
async function exportFilesContainer(){
  const ids = fileDocs().map(f => f.id); const items = [], parts = [];
  for (const id of ids){ const r = await blobGet(id); if (!r) continue; items.push({id, iv: r.iv, len: r.ct.byteLength}); parts.push(r.ct); }
  if (!items.length){ toast('No documents to back up.'); return; }
  const head = te.encode(JSON.stringify({format: 'zss-files', v: 1, created: new Date().toISOString(), items}));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, head.length);
  const blob = new Blob([MAGIC_C, len, head].concat(parts), {type: 'application/octet-stream'});
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'zss-documents-' + today() + '.zssfiles';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  await metaSet('lastFilesBackup', new Date().toISOString()); renderSettings();
}
async function importFilesContainer(file){
  const buf = await file.arrayBuffer(); const u8 = new Uint8Array(buf);
  if (td.decode(u8.subarray(0, 5)) !== 'ZSSF1') throw new Error('That is not a ZSS documents backup (.zssfiles).');
  const hl = new DataView(buf, 5, 4).getUint32(0); const head = JSON.parse(td.decode(u8.subarray(9, 9 + hl)));
  let off = 9 + hl, n = 0; const have = new Set(await blobKeys());
  for (const it of head.items){ const ct = buf.slice(off, off + it.len); off += it.len; if (have.has(it.id)) continue;
    await tx(['blobs'], 'readwrite', t => { t.objectStore('blobs').put({id: it.id, iv: it.iv, ct}); }); n++; }
  return n;
}
async function blobsToFolder(h){
  const ids = fileDocs().map(f => f.id); if (!ids.length) return;
  const done = new Set((await metaGet('blobsBacked')) || []); const todo = ids.filter(id => !done.has(id)); if (!todo.length) return;
  const dir = await h.getDirectoryHandle('zss-documents', {create: true});
  for (const id of todo){
    const r = await blobGet(id); if (!r) continue;
    const fh = await dir.getFileHandle(id + '.zssblob', {create: true}); const w = await fh.createWritable();
    await w.write(new Blob([MAGIC_B, unb64(r.iv), r.ct])); await w.close(); done.add(id);
  }
  await metaSet('blobsBacked', [...done]); await metaSet('lastFilesBackup', new Date().toISOString());
}
async function filesFromFolder(){
  const h = await window.showDirectoryPicker({id: 'zss-backup', mode: 'read'});
  let dir = h; try { dir = await h.getDirectoryHandle('zss-documents'); } catch(e){}
  const have = new Set(await blobKeys()); let n = 0;
  for await (const [name, fh] of dir.entries()){
    if (!name.endsWith('.zssblob')) continue; const id = name.slice(0, -8); if (have.has(id)) continue;
    const buf = await (await fh.getFile()).arrayBuffer(); const u8 = new Uint8Array(buf);
    if (td.decode(u8.subarray(0, 5)) !== 'ZSSB1') continue;
    await tx(['blobs'], 'readwrite', t => { t.objectStore('blobs').put({id, iv: b64(u8.slice(5, 17)), ct: buf.slice(17)}); }); n++;
  }
  return n;
}
async function renderFilesSettings(){
  const all = fileDocs(); $('#s-files').textContent = all.length + ' file' + (all.length === 1 ? '' : 's') + ', ' + kb(all.reduce((t, f) => t + (f.size || 0), 0));
  $('#s-flast').textContent = ago(await metaGet('lastFilesBackup'));
  $('#b-ffolder').hidden = !hasFolderApi();
}

/* ================= passwords =================
 * A second lock. Each login is sealed with a key from a separate passphrase, and the sealed result is
 * then stored as an ordinary record (so it is sealed twice and rides along in every backup). The
 * passwords are never readable while this section is locked; it locks itself after 3 minutes idle and
 * whenever you leave it. The two Claude pages and their frames cannot reach any of it.
 */
const PWMETA = 'side/vault/meta/v', PWITEMS = 'side/vault/items';
const PW = { key: null, items: new Map(), side: 'all', q: '', last: 0, edit: null, clipTimer: 0 };
function pwLock(){ PW.key = null; PW.items.clear(); PW.edit = null; const pd = $('#pwd'); if (pd && pd.open) pd.close(); if (!$('#v-pw').hidden) renderPw(); }
async function pwLoad(){
  PW.items.clear();
  for (const [p, d] of S.docs) if (p.startsWith(PWITEMS + '/') && d.s){ try { PW.items.set(idOf(p), await unseal(PW.key, d.s)); } catch(e){} }
}
function pwGen(n){
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+?'];
  const all = sets.join(''); const pick = s => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const out = sets.map(pick); while (out.length < n) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--){ const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}
const host = u => { try { return new URL(/^https?:/i.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch(e){ return u || ''; } };
async function copySecret(text, what){
  try { await navigator.clipboard.writeText(text); } catch(e){ toast('Copy did not work here.'); return; }
  toast(what + ' copied. The clipboard clears in 30 seconds.');
  clearTimeout(PW.clipTimer); PW.clipTimer = setTimeout(() => { navigator.clipboard.writeText('').catch(() => {}); }, 30000);
}
async function renderPw(){
  if ($('#v-pw').hidden) return;
  const hasVault = S.docs.has(PWMETA);
  $('#pw-setup').hidden = hasVault || !!PW.key; $('#pw-unlock').hidden = !hasVault || !!PW.key; $('#pw-open').hidden = !PW.key; $('#pw-acts').hidden = !PW.key;
  if (!PW.key) return;
  const q = PW.q.trim().toLowerCase(); const items = [...PW.items.entries()].map(([id, v]) => Object.assign({id}, v));
  const count = {}; items.forEach(i => { if (i.pass) count[i.pass] = (count[i.pass] || 0) + 1; });
  document.querySelectorAll('#pw-side button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === PW.side)));
  const shown = items.filter(i => (PW.side === 'all' || i.side === PW.side) && (!q || [i.title, i.url, i.user, i.notes].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const reused = items.filter(i => i.pass && count[i.pass] > 1).length, weak = items.filter(i => i.pass && strength(i.pass) < .6).length;
  $('#pw-sum').textContent = items.length + ' login' + (items.length === 1 ? '' : 's') + (reused ? ' · ' + reused + ' share a password' : '') + (weak ? ' · ' + weak + ' weak' : '');
  const L = $('#pw-list');
  if (!shown.length){ L.innerHTML = '<p class="empty">' + (items.length ? 'Nothing matches.' : 'No logins yet. Add one, or start with your email, bank and phone accounts.') + '</p>'; return; }
  L.innerHTML = shown.map(i => {
    const flags = [];
    if (i.pass && count[i.pass] > 1) flags.push('<span class="flag crit">same password elsewhere</span>');
    if (i.pass && strength(i.pass) < .6) flags.push('<span class="flag warn">weak</span>');
    if (i.changed && Date.now() - Date.parse(i.changed) > 365 * 864e5) flags.push('<span class="flag">not changed in a year</span>');
    return '<div class="pwrow" data-pw="' + esc(i.id) + '"><div class="pwt"><b>' + esc(i.title || host(i.url) || 'Untitled') + '</b><span class="muted">' + esc(host(i.url)) + (i.user ? ' · ' + esc(i.user) : '') + ' · ' + (i.side === 'holdings' ? 'Business' : 'Personal') + '</span>' + (flags.length ? '<span class="flags">' + flags.join('') + '</span>' : '') + '</div>'
      + '<div class="pwa">' + (i.user ? '<button class="btn sm" type="button" data-pwc="user">Copy user</button>' : '') + (i.pass ? '<button class="btn sm" type="button" data-pwc="pass">Copy password</button>' : '')
      + '<button class="btn sm" type="button" data-pwc="edit">Open</button></div></div>';
  }).join('');
}
async function pwSave(id, obj){
  const s = await seal(PW.key, obj); await docRef(PWITEMS + '/' + id).set({s}); PW.items.set(id, obj);
}
function pwOpenEditor(id){
  const v = id ? PW.items.get(id) : {side: PW.side === 'holdings' ? 'holdings' : 'personal'};
  PW.edit = id || null;
  $('#pe-title').value = v.title || ''; $('#pe-url').value = v.url || ''; $('#pe-user').value = v.user || ''; $('#pe-pass').value = v.pass || '';
  $('#pe-side').value = v.side || 'personal'; $('#pe-notes').value = v.notes || ''; $('#pe-pass').type = 'password'; $('#pe-show').textContent = 'Show';
  $('#pe-del').hidden = !id; $('#pe-h').textContent = id ? (v.title || 'Login') : 'New login';
  $('#pe-meta').textContent = id ? ('Added ' + new Date(v.created).toLocaleDateString() + (v.changed ? ' · password changed ' + new Date(v.changed).toLocaleDateString() : '')) : '';
  pwMeter(); $('#pwd').showModal(); setTimeout(() => $('#pe-title').focus(), 30);
}
function pwMeter(){ const p = $('#pe-pass').value, s = strength(p), m = $('#pe-meter'); m.style.width = (p ? Math.round(s * 100) : 0) + '%'; m.style.background = s < .5 ? 'var(--crit)' : s < .8 ? 'var(--warn)' : 'var(--good)'; }

/* ---------- wiring: documents ---------- */
$('#d-add').addEventListener('change', e => { const l = [...e.target.files]; e.target.value = ''; addFiles(l).catch(err => toast(err.message || 'Could not add that file.')); });
$('#d-cam').addEventListener('change', e => { const l = [...e.target.files]; e.target.value = ''; addFiles(l).catch(err => toast(err.message || 'Could not add that photo.')); });
$('#d-side').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; D.side = b.dataset.v; renderDocs(); });
$('#d-cat').innerHTML = '<option value="">Every kind</option>' + CATS.map(([k, n]) => '<option value="' + k + '">' + n + '</option>').join('');
$('#dv-cat').innerHTML = CATS.map(([k, n]) => '<option value="' + k + '">' + n + '</option>').join('');
$('#d-cat').addEventListener('change', e => { D.cat = e.target.value; renderDocs(); });
$('#d-q').addEventListener('input', e => { D.q = e.target.value; renderDocs(); });
$('#d-grid').addEventListener('click', e => { const c = e.target.closest('[data-file]'); if (c) openFile(c.dataset.file); });
const stage = $('#stage');
stage.addEventListener('dragover', e => { if (S.side === 'docs'){ e.preventDefault(); stage.classList.add('drop'); } });
stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
stage.addEventListener('drop', e => { if (S.side !== 'docs') return; e.preventDefault(); stage.classList.remove('drop'); addFiles([...e.dataTransfer.files]); });
$('#dv').addEventListener('close', () => { if (D.url){ URL.revokeObjectURL(D.url); D.url = null; } D.open = null; $('#dv-prev').textContent = ''; });
$('#d-restore-file').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { const n = await importFilesContainer(f); toast(n + ' document' + (n === 1 ? '' : 's') + ' restored.'); renderDocs(); renderSettings(); } catch(err){ toast(err.message || 'That did not work.'); }
});

/* ---------- wiring: passwords ---------- */
$('#pw-setup').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.currentTarget, msg = $('#pws-msg'), p = $('#pws-p1').value;
  if (p.length < 12){ msg.className = 'msg err'; msg.textContent = 'At least 12 characters.'; return; }
  if (p !== $('#pws-p2').value){ msg.className = 'msg err'; msg.textContent = 'The two don’t match.'; return; }
  busy(f, true); msg.className = 'msg'; msg.textContent = 'Checking…';
  try {
    if (await openVault(await metaGet('vault'), p)){ msg.className = 'msg err'; msg.textContent = 'Use a different passphrase from the one that opens the app.'; return; }
    const {key, vault} = await newVault(p);
    await docRef(PWMETA).set({kdf: vault.kdf, check: vault.check, created: vault.created});
    PW.key = key; PW.last = Date.now(); await pwLoad(); f.reset(); msg.textContent = ''; renderPw();
  } finally { busy(f, false); }
});
$('#pw-unlock').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.currentTarget, msg = $('#pwu-msg');
  busy(f, true); msg.className = 'msg'; msg.textContent = 'Opening…';
  try {
    const key = await openVault(S.docs.get(PWMETA), $('#pwu-pass').value);
    if (!key){ msg.className = 'msg err'; msg.textContent = 'That passphrase does not open your passwords.'; await sleep(1200); return; }
    PW.key = key; PW.last = Date.now(); await pwLoad(); f.reset(); msg.textContent = ''; renderPw();
  } finally { busy(f, false); }
});
$('#pw-side').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; PW.side = b.dataset.v; renderPw(); });
$('#pw-q').addEventListener('input', e => { PW.q = e.target.value; renderPw(); });
$('#pw-list').addEventListener('click', e => {
  const b = e.target.closest('[data-pwc]'), row = e.target.closest('[data-pw]'); if (!b || !row || !PW.key) return;
  const v = PW.items.get(row.dataset.pw); if (!v) return; PW.last = Date.now();
  if (b.dataset.pwc === 'user') copySecret(v.user, 'Username'); else if (b.dataset.pwc === 'pass') copySecret(v.pass, 'Password'); else pwOpenEditor(row.dataset.pw);
});
$('#pe-pass').addEventListener('input', pwMeter);
$('#pe-show').addEventListener('click', () => { const i = $('#pe-pass'); i.type = i.type === 'password' ? 'text' : 'password'; $('#pe-show').textContent = i.type === 'password' ? 'Show' : 'Hide'; });
$('#pe-gen').addEventListener('click', () => { $('#pe-pass').value = pwGen(20); $('#pe-pass').type = 'text'; $('#pe-show').textContent = 'Hide'; pwMeter(); });
$('#pe-copy').addEventListener('click', () => { if ($('#pe-pass').value) copySecret($('#pe-pass').value, 'Password'); });
$('#pe-form').addEventListener('submit', async e => {
  e.preventDefault(); if (!PW.key) return;
  const old = PW.edit ? PW.items.get(PW.edit) : null; const id = PW.edit || rid(); const pass = $('#pe-pass').value; const now = new Date().toISOString();
  const v = {title: $('#pe-title').value.trim(), url: $('#pe-url').value.trim(), user: $('#pe-user').value.trim(), pass, side: $('#pe-side').value,
    notes: $('#pe-notes').value.trim(), created: old ? old.created : now, changed: old ? (old.pass !== pass ? now : old.changed) : now};
  await pwSave(id, v); $('#pwd').close(); PW.last = Date.now(); renderPw(); toast('Saved, encrypted twice.');
});
$('#pe-del').addEventListener('click', async () => {
  if (!PW.edit || !confirm('Delete this login? It stays in older snapshots and backups until they roll over.')) return;
  await docRef(PWITEMS + '/' + PW.edit).delete(); PW.items.delete(PW.edit); $('#pwd').close(); renderPw();
});
['input', 'pointerdown', 'keydown'].forEach(ev => $('#v-pw').addEventListener(ev, () => { PW.last = Date.now(); }, true));
['input', 'pointerdown', 'keydown'].forEach(ev => $('#pwd').addEventListener(ev, () => { PW.last = Date.now(); }, true));
setInterval(() => { if (PW.key && Date.now() - PW.last > 3 * 60000){ pwLock(); toast('Passwords locked after 3 minutes.'); } }, 10000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && PW.key) pwLock(); });

/* ---------- wiring: shared actions ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  try {
    if (act === 'dv-save'){
      const p = FILES + '/' + D.open; if (!S.docs.has(p)) return;
      await docRef(p).update({name: $('#dv-name').value.trim() || 'Untitled', side: $('#dv-side').value, cat: $('#dv-cat').value, date: $('#dv-date').value, note: $('#dv-note').value.trim()});
      $('#dv').close(); renderDocs(); toast('Saved.');
    }
    else if (act === 'dv-open'){ if (D.url) window.open(D.url, '_blank', 'noopener'); }
    else if (act === 'dv-copy'){ if (D.url){ const f = S.docs.get(FILES + '/' + D.open); const a = document.createElement('a'); a.href = D.url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); } }
    else if (act === 'dv-del'){
      if (!confirm('Delete this file? It can be brought back from a snapshot for 30 days, and from your documents backups.')) return;
      const id = D.open; $('#dv').close(); await docRef(FILES + '/' + id).delete(); await gcBlobs(); renderDocs(); toast('Deleted.');
    }
    else if (act === 'dv-close') $('#dv').close();
    else if (act === 'files-export') await exportFilesContainer();
    else if (act === 'files-restore') $('#d-restore-file').click();
    else if (act === 'files-folder'){ const n = await filesFromFolder(); toast(n + ' document' + (n === 1 ? '' : 's') + ' restored from the folder.'); renderDocs(); renderSettings(); }
    else if (act === 'pw-add'){ if (PW.key) pwOpenEditor(null); }
    else if (act === 'pw-lock') pwLock();
    else if (act === 'pe-close') $('#pwd').close();
  } catch(err){ if (err && err.name === 'AbortError') return; console.error(err); toast(err.message || 'That did not work.'); }
});

/* ---------------- start ---------------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
(async () => {
  if (!window.crypto || !crypto.subtle || !window.indexedDB){ document.body.textContent = 'This browser cannot run ZSS (it needs secure storage). Use a current Edge, Chrome or Safari.'; return; }
  showGate((await metaGet('vault')) ? 'unlock' : 'setup');
})();
})();
