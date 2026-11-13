// Browser host: runs the authoritative game core (js/game.bundle.js, built from server/game.js) in this tab,
// stores worlds in IndexedDB (named slots, export/import), and accepts friends over PeerJS (room code).
import { ICE, PEER_PREFIX, serverConnFromPeer, loopback } from './net.js';
const DATA_FILES = ['items', 'structures', 'enemies', 'shops', 'loot', 'biomes', 'nodes', 'status', 'town', 'recipes'];
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const newCode = () => Array.from({ length: 5 }, () => CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)]).join('');

// ---------- storage: IndexedDB 'meadowcraft' / store 'worlds' { name, code, seed, save, updated }
let dbP = null;
function db() {
  return dbP || (dbP = new Promise((res, rej) => { const r = indexedDB.open('meadowcraft', 1); r.onupgradeneeded = () => r.result.createObjectStore('worlds', { keyPath: 'name' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('worlds', mode), s = t.objectStore('worlds'), r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
export const listWorlds = async () => (await tx('readonly', s => s.getAll())) || [];
export const getWorld = async name => {
  const rec = await tx('readonly', s => s.get(name));
  // a synchronous localStorage mirror is written on pagehide (IndexedDB writes can be cut off when a tab closes); take whichever is newer
  try { const ls = JSON.parse(localStorage.getItem('mc_backup_' + name) || 'null'); if (ls && (!rec || (ls.save?.savedAt || '') > (rec.save?.savedAt || ''))) return { ...(rec || {}), ...ls }; } catch {}
  return rec;
};
export const putWorld = rec => tx('readwrite', s => s.put({ ...rec, updated: Date.now() }));
export const deleteWorld = name => tx('readwrite', s => s.delete(name));
export async function exportWorld(name) {
  const rec = await getWorld(name); if (!rec) return;
  const blob = new Blob([JSON.stringify({ format: 'meadowcraft-world', version: 1, ...rec })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `meadowcraft-${name.replace(/\W+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export async function importWorld(file) {
  const j = JSON.parse(await file.text()); if (j.format !== 'meadowcraft-world' || !j.save) throw new Error('Not a Meadowcraft world file');
  const names = new Set((await listWorlds()).map(w => w.name)); let name = j.name || 'Imported'; while (names.has(name)) name += ' (copy)';
  await putWorld({ name, code: j.code || newCode(), seed: j.seed || j.save.seed, save: j.save }); return name;
}

// ---------- hosting
let DATA = null;
const loadData = async () => DATA || (DATA = Object.fromEntries(await Promise.all(DATA_FILES.map(async f => [f === 'enemies' ? 'enemies' : f, await (await fetch(`data/${f}.json`)).json()]))));
export const H = { game: null, peer: null, slot: null, code: null, status: 'off', wake: null, onStatus: () => {} };
window.__mc_host = H; // read-only debug/test hook
async function wakeLock() { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') H.wake = await navigator.wakeLock.request('screen'); } catch {} }
// Timers driven by a Web Worker: a hidden tab throttles its own setInterval to >=1 s (or worse), but worker timers keep
// firing, so the world keeps ticking at full speed for friends while the host switches tabs (desktop; phones may still suspend).
function workerTimers() {
  try {
    const w = new Worker(URL.createObjectURL(new Blob([`const t={};onmessage=e=>{const[k,id,ms]=e.data;if(k==='s')t[id]=setInterval(()=>postMessage(id),ms);else clearInterval(t[id]);}`], { type: 'text/javascript' })));
    const fns = new Map(); let n = 0; w.onmessage = e => { const f = fns.get(e.data); f && f(); };
    return { every: (fn, ms) => { const id = ++n; fns.set(id, fn); w.postMessage(['s', id, ms]); return id; }, clearEvery: id => { fns.delete(id); w.postMessage(['c', id]); } };
  } catch { return {}; }
}
export async function startHosting(slotName, { seed, test } = {}) {
  let rec = await getWorld(slotName);
  if (!rec) rec = { name: slotName, code: newCode(), seed: seed || ((Math.random() * 1e9) | 0), save: null }, await putWorld(rec);
  H.slot = rec.name; H.code = rec.code;
  const data = await loadData();
  H.game = window.MeadowGame.createGame({ data, save: rec.save, seed: rec.seed, test: !!test, ...workerTimers(),
    persist: save => { rec.save = save; putWorld({ name: rec.name, code: rec.code, seed: rec.seed, save }).catch(e => console.warn('save failed', e)); } });
  const mirror = () => { try { const save = H.game.saveWorld(); localStorage.setItem('mc_backup_' + rec.name, JSON.stringify({ name: rec.name, code: rec.code, seed: rec.seed, save })); } catch (e) { console.warn(e); } };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') mirror(); else wakeLock(); });
  addEventListener('pagehide', mirror);
  wakeLock(); openRoom();
  const [server, client] = loopback(); H.game.connect(server);
  return client;
}
function openRoom(tries = 0) {
  H.status = 'connecting'; H.onStatus();
  const peer = H.peer = new window.Peer(PEER_PREFIX + H.code, { config: ICE, debug: 1 });
  peer.on('open', () => { H.status = 'online'; H.onStatus(); });
  peer.on('connection', dc => dc.on('open', () => H.game.connect(serverConnFromPeer(dc))));
  peer.on('disconnected', () => { H.status = 'reconnecting'; H.onStatus(); setTimeout(() => !peer.destroyed && peer.reconnect(), 2000); });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { // our old tab (or a reload) still holds the room id on the signalling server for a few seconds
      H.status = 'waiting for room'; H.onStatus(); peer.destroy(); if (tries < 20) setTimeout(() => openRoom(tries + 1), 3000); else { H.status = 'room code busy'; H.onStatus(); }
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) { H.status = 'offline (retrying)'; H.onStatus(); }
  });
}
export const playerCount = () => H.game ? H.game.stats().online.length : 0;
export const shareUrl = () => location.origin + location.pathname.replace(/index\.html$/, '') + '?room=' + H.code;
