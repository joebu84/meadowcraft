// Sheeple / Meadowcraft client: plain canvas renderer, local movement prediction, server-authoritative everything else.
// Transport: WebSocket to the Node server, or (static GitHub Pages build) PeerJS to a friend's browser / in-tab host. See net.js + host.js.
import { STATIC, joinRoom, openWebSocket } from './net.js';
import * as Host from './host.js';
const $ = id => document.getElementById(id);
const cv = $('game'), ctx = cv.getContext('2d');
const T = 32, SPEED = 130, PR = 9, INTERP = 110;
const TILE = { WATER: 4, BRIDGE: 10, FENCE: 11, FOUNTAIN: 13 };
const SOLID_TILES = new Set([4, 11, 13, 16, 17]);
const S = { mobSt: {}, mobBite: {}, me: null, nodes: [], nodeAt: new Map(), structs: new Map(), objAt: new Map(), floorAt: new Map(), houses: [], snaps: [], fx: [], pos: { x: 0, y: 0, a: Math.PI / 2, s: 0 }, keys: {}, joy: { x: 0, y: 0 }, build: { on: false, item: null, tx: 0, ty: 0, manual: false }, panel: null, chest: null, lastAtk: 0, lastSend: 0, dens: [], sealed: new Set() };
const myFl = () => S.me?.fl || 0;
const SK = (fl, x, y) => (fl || 0) + ':' + x + ',' + y;
const objGet = (tx, ty, fl = myFl()) => S.objAt.get(SK(fl, tx, ty));
const floorGet = (tx, ty, fl = myFl()) => S.floorAt.get(SK(fl, tx, ty));
function inFootprint(fl, tx, ty) {
  if (!fl) return true;
  const k = K(tx, ty);
  for (const h of S.houses) if ((h.floors[fl] || h.floors[String(fl)] || []).includes(k)) return true;
  return false;
}
window.__sheeple = S;
S.send = m => send(m);
const K = (x, y) => x + ',' + y;
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// ---------------- assets (everything comes from assets/manifest.json)
const IMG = {}, ICON = {};
let MAN;
function placeholder(w, h, color) { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h); return c; }
async function loadAssets() {
  MAN = await (await fetch('assets/manifest.json')).json();
  const load = (src, fb) => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(fb()); i.src = 'assets/' + src; });
  await Promise.all([
    ...Object.entries(MAN.sprites).map(async ([k, s]) => { IMG[k] = await load(s.file, () => placeholder(s.fw * s.cols, s.fh * s.rows, '#f0f')); }),
    ...Object.entries(MAN.items).map(async ([k, f]) => { ICON[k] = await load(f, () => placeholder(16, 16, '#f0f')); }),
  ]);
}
function spr(key, col, row, x, y, alpha) {
  const s = MAN.sprites[key]; if (!s) { ctx.fillStyle = '#f0f'; ctx.fillRect(x - 8, y - 16, 16, 16); return; }
  const sc = s.scale || 1, w = s.fw * sc, h = s.fh * sc;
  if (alpha !== undefined) ctx.globalAlpha = alpha;
  ctx.drawImage(IMG[key], (col % s.cols) * s.fw, (row % s.rows) * s.fh, s.fw, s.fh, Math.round(x - s.anchor[0] * sc), Math.round(y - s.anchor[1] * sc), w, h);
  ctx.globalAlpha = 1;
}
const ROW8 = [2, 5, 0, 4, 1, 6, 3, 7]; // angle octant (E,SE,S,SW,W,NW,N,NE) -> sheet row
function dirIndex(s, a) { if (!s.dirs8) return dirRow(a); return ROW8[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8]; }
// characters: 8-dir rows if present, walk frames or a 1px bob, optional one-shot anims (attack/charge/emote) from the manifest
function drawChar(key, x, y, ang, moving, seed, role, prog) {
  const s = MAN.sprites[key]; if (!s) return spr(key, 0, 0, x, y);
  const now = performance.now(); let row = dirIndex(s, ang), col = 0, bob = 0;
  const an = role && s.anims && s.anims[role];
  if (an) { row = an.row + dirRow(ang); col = Math.max(0, Math.min(an.frames - 1, Math.floor(prog * an.frames))); }
  else if (moving) { const wf = s.walkFrames || s.cols; if (wf > 1) col = 1 + ((now / 140 + seed) | 0) % (wf - 1); else bob = ((now / 160 + seed) | 0) % 2; }
  spr(key, col, row, x, y - bob);
}
const spriteTop = key => { const s = MAN.sprites[key]; return s ? (s.top || 30) * (s.scale || 1) : 30; };
const iconUrl = id => 'assets/' + (MAN.items[id] || `items/${id}.png`);
const dirRow = a => { const c = Math.cos(a), s = Math.sin(a); return Math.abs(c) > Math.abs(s) ? (c > 0 ? 2 : 1) : (s > 0 ? 0 : 3); };

// ---------------- net
let ws, D; // D = game data from server (items, recipes, ...)
const NET = { mode: 'ws', room: null, client: null, retries: 0 }; // mode: 'ws' (Node server) | 'host' (this tab runs the world) | 'join' (PeerJS to a host)
const TOKEN = localStorage.getItem('mc_token') || (localStorage.setItem('mc_token', Math.random().toString(36).slice(2) + Date.now().toString(36)), localStorage.getItem('mc_token'));
// joiners: snapshots arrive ~20x/s, so 6 s of silence means the host tab went away even if the WebRTC link hasn't noticed yet
setInterval(() => { if (NET.mode === 'join' && S.joined && ws && ws.readyState === 1 && performance.now() - (NET.lastMsg || 0) > 6000) { NET.lastMsg = performance.now(); ws.close(); } }, 1000);
function netBanner(text) { const b = $('netBanner'); b.textContent = text || ''; b.classList.toggle('hidden', !text); }
function connect(name) {
  ws = NET.mode === 'host' ? NET.client : NET.mode === 'join' ? joinRoom(NET.room) : openWebSocket();
  const me = ws;
  ws.onopen = () => me.send(JSON.stringify({ t: 'join', name, token: TOKEN }));
  ws.onmessage = e => { NET.lastMsg = performance.now(); onMsg(JSON.parse(e.data)); };
  ws.onclose = e => {
    if (me !== ws || NET.mode === 'host') return;
    if (S.joined) { netBanner(NET.mode === 'join' ? 'Host disconnected, reconnecting...' : 'Disconnected, reconnecting...'); NET.retries++; setTimeout(() => connect(name), Math.min(8000, 1500 + NET.retries * 1000)); }
    else if (NET.mode === 'join') { $('joinErr').textContent = e && e.reason === 'no-host' ? `No world is open with code ${NET.room}. Ask the host to open (and keep open) their Meadowcraft tab.` : `Could not connect to room ${NET.room} (${(e && e.reason) || 'error'}). Try again.`; setLobbyBusy(false); }
  };
}
const send = m => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
function onMsg(m) {
  switch (m.t) {
    case 'err': $('joinErr').textContent = m.msg; ws.onclose = null; ws.close(); setLobbyBusy(false); break;
    case 'welcome': return welcome(m);
    case 'me': S.me = m.me; refreshHud(); refreshPanel(); break;
    case 'pos': S.pos.x = m.x; S.pos.y = m.y; S.pos.s = m.s; if (m.fl != null && S.me) S.me.fl = m.fl; if (m.anim === 'hook') S.fx.push({ k: 'zip', t: performance.now(), x: m.x, y: m.y }); break;
    case 'houses': S.houses = m.houses || []; break;
    case 's': S.snaps.push({ t: performance.now(), p: new Map(m.p.map(r => [r[0], r])), e: new Map(m.e.map(r => [r[0], r])), b: m.b }); if (S.snaps.length > 30) S.snaps.shift(); break;
    case 'n': { const n = S.nodes[m.id]; if (n) n.on = m.on; break; }
    case 'st': addStruct(m.s); break;
    case 'st-': delStruct(m.id); break;
    case 'den': S.sealed.add(m.id); break;
    case 'toast': toast(m.text); break;
    case 'got': floatText(S.pos.x, S.pos.y - 30, `+${m.n} ${D.items[m.id].name}`, '#bfffa0'); break;
    case 'chest': S.chest = { sid: m.sid, items: m.items }; if (S.panel?.type !== 'chest') openPanel('chest'); else refreshPanel(); break;
    case 'chat': toast(`${m.from}: ${m.text}`); break;
    case 'died': toast(`You were defeated${m.by ? ' by ' + m.by : ''}! Lost ${m.lost} coins. ${m.bed ? 'Respawned at your bed.' : 'Respawned in town.'}`); break;
    case 'fx': onFx(m); break;
  }
}
function welcome(m) {
  D = m.data; S.id = m.id; S.me = m.me; S.pos = { x: m.pos.x, y: m.pos.y, a: Math.PI / 2, s: m.pos.s }; S.test = m.test;
  const w = m.world; S.W = w.W; S.H = w.H; S.town = w.town; S.buildings = w.buildings; S.npcs = w.npcs; S.dens = w.dens;
  S.tiles = Uint8Array.from(atob(w.tiles), c => c.charCodeAt(0));
  S.blocked = new Set(); for (const b of w.buildings) if (!b.noBlock) for (let y = b.ty; y < b.ty + b.h; y++) for (let x = b.tx; x < b.tx + b.w; x++) if (!(b.door && b.door.tx === x && b.door.ty === y)) S.blocked.add(y * S.W + x);
  S.mainH = w.mainH || w.H; S.interiors = w.interiors || {}; S.maze = w.maze; S.lair = w.lair;
  S.nodes = []; S.nodeAt.clear(); for (const [id, type, tx, ty, on] of w.nodes) { const n = { id, type, tx, ty, on }; S.nodes[id] = n; S.nodeAt.set(K(tx, ty), n); }
  S.houses = w.houses || []; S.structs.clear(); S.objAt.clear(); S.floorAt.clear(); for (const s of w.structures) addStruct(s);
  buildMinimap();
  S.joined = true; NET.retries = 0; netBanner(''); $('join').classList.add('hidden');
  for (const id of ['hud', 'hotbar', 'minimap']) $(id).classList.remove('hidden');
  if (isTouch) $('touch').classList.remove('hidden');
  refreshHud(); toast('Welcome to Woolhaven! Punch trees (⚔) for wood, pick up loose rocks (✋).');
}
function addStruct(s) { const old = S.structs.get(s.id); if (old) unindex(old); s.fl = s.fl || 0; S.structs.set(s.id, s); (D.structures[s.type].layer === 'floor' ? S.floorAt : S.objAt).set(SK(s.fl, s.tx, s.ty), s); }
function unindex(s) { const m = D.structures[s.type].layer === 'floor' ? S.floorAt : S.objAt; if (m.get(SK(s.fl, s.tx, s.ty))?.id === s.id) m.delete(SK(s.fl, s.tx, s.ty)); }
function delStruct(id) { const s = S.structs.get(id); if (s) { unindex(s); S.structs.delete(id); } }
function onFx(m) {
  const t = performance.now();
  if (m.k === 'hit') floatText(m.x, m.y, '-' + m.d, m.pl ? '#ff6060' : m.ia ? '#d9a0ff' : '#ffffff');
  else if (m.k === 'swing') S.fx.push({ k: 'swing', id: m.id, a: m.a, w: m.w, t });
  else if (m.k === 'die') S.fx.push({ k: 'poof', x: m.x, y: m.y, t });
  else if (m.k === 'bite') S.mobBite[m.id] = t;
  else if (m.k === 'honk') floatText(m.x, m.y - (m.big ? 70 : 40), m.big ? 'HOOONK!!' : 'HONK!', m.big ? '#ff9040' : '#ffe070');
  else if (m.k === 'shock') S.fx.push({ k: 'shock', x: m.x, y: m.y, r: m.r, t });
  else if (m.k === 'hook') S.fx.push({ k: 'hook', x: m.x, y: m.y, a: m.a, len: m.len, t });
  else if (m.k === 'cast') S.fx.push({ k: 'cast', x: m.x, y: m.y, a: m.a, t, until: t + m.ms });
  else if (m.k === 'chop') S.fx.push({ k: 'chip', x: m.x, y: m.y, t });
  else if (m.k === 'den') S.fx.push({ k: 'poof', x: m.x, y: m.y, t, c: '#000' });
}
function floatText(x, y, text, color) { S.fx.push({ k: 'text', x, y, text, color, t: performance.now() }); }
function toast(text) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = text; $('toasts').appendChild(d); setTimeout(() => d.remove(), 4000); while ($('toasts').children.length > 4) $('toasts').firstChild.remove(); }

// ---------------- collision (mirror of server rules for players)
function tileSolid(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= S.W || ty >= S.H) return true;
  const fl = myFl();
  if (fl > 0) {
    if (!inFootprint(fl, tx, ty)) return true;
    const s = objGet(tx, ty, fl); return !!(s && D.structures[s.type].solid);
  }
  const i = ty * S.W + tx; if (SOLID_TILES.has(S.tiles[i]) || S.blocked.has(i)) return true;
  const n = S.nodeAt.get(K(tx, ty)); if (n && n.on && D.nodes?.[n.type]?.solid) return true;
  const s = objGet(tx, ty, 0); if (s && D.structures[s.type].solid) return true;
  return false;
}
function blockedAt(x, y, r) { const x0 = Math.floor((x - r) / T), x1 = Math.floor((x + r) / T), y0 = Math.floor((y - r) / T), y1 = Math.floor((y + r) / T); for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (tileSolid(tx, ty)) return true; return false; }

// ---------------- input
const held = () => S.me?.inv[S.me.sel]?.id || null;
const itemDef = id => D.items[id];
addEventListener('keydown', e => {
  if (!S.joined || e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase(); S.keys[k] = true;
  if (k === ' ') e.preventDefault();
  if (k === 'e') interact();
  else if (k === 'i') togglePanel('bag');
  else if (k === 'c') togglePanel('craft');
  else if (k === 'b') toggleBuild();
  else if (k === 'escape') { closePanel(); if (S.build.on) toggleBuild(); }
  else if (k >= '1' && k <= '6') selectSlot(+k - 1);
  else if (k === 'r' && S.build.on) buildAction('demolish');
  else if (k === 'u' && S.build.on) buildAction('upgrade');
});
addEventListener('keyup', e => { S.keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { S.keys = {}; });
// mouse: aim/attack, build target
let mouse = null;
cv.addEventListener('mousemove', e => { mouse = { x: e.clientX, y: e.clientY }; if (S.build.on) { const w = screenToWorld(e.clientX, e.clientY); S.build.tx = Math.floor(w.x / T); S.build.ty = Math.floor(w.y / T); S.build.manual = true; } });
cv.addEventListener('mousedown', e => { if (!S.joined || isTouch) return; const w = screenToWorld(e.clientX, e.clientY); if (S.build.on) { S.build.tx = Math.floor(w.x / T); S.build.ty = Math.floor(w.y / T); placeBuild(); return; } S.pos.a = Math.atan2(w.y - (S.pos.y - 10), w.x - S.pos.x); S.mouseHeld = true; doAttack(); });
addEventListener('mouseup', () => { S.mouseHeld = false; });
// touch joystick (left side) + taps
const stick = $('stick'), knob = $('knob');
let joyId = null, joyBase = null, joyStart = 0;
cv.addEventListener('touchstart', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (joyId === null && t.clientX < innerWidth * 0.55) { joyId = t.identifier; joyBase = { x: t.clientX, y: t.clientY }; joyStart = performance.now(); stick.style.left = (t.clientX - 60) + 'px'; stick.style.top = (t.clientY - 60) + 'px'; stick.style.bottom = 'auto'; }
    else tapAt(t.clientX, t.clientY);
  }
}, { passive: false });
cv.addEventListener('touchmove', e => { e.preventDefault(); for (const t of e.changedTouches) if (t.identifier === joyId) { let dx = t.clientX - joyBase.x, dy = t.clientY - joyBase.y; const d = Math.hypot(dx, dy), m = 50; if (d > m) { dx *= m / d; dy *= m / d; } S.joy = { x: dx / m, y: dy / m }; knob.style.transform = `translate(${dx}px,${dy}px)`; if (d > 8) S.build.manual = false; } }, { passive: false });
const endTouch = e => { for (const t of e.changedTouches) if (t.identifier === joyId) { if (performance.now() - joyStart < 220 && Math.hypot(t.clientX - joyBase.x, t.clientY - joyBase.y) < 10) tapAt(t.clientX, t.clientY); joyId = null; S.joy = { x: 0, y: 0 }; knob.style.transform = ''; stick.style.left = ''; stick.style.top = ''; stick.style.bottom = ''; } };
cv.addEventListener('touchend', endTouch); cv.addEventListener('touchcancel', endTouch);
function tapAt(cx, cy) { if (!S.build.on) return; const w = screenToWorld(cx, cy); S.build.tx = Math.floor(w.x / T); S.build.ty = Math.floor(w.y / T); S.build.manual = true; }
const holdBtn = (el, fn) => { el.addEventListener('touchstart', e => { e.preventDefault(); el.classList.add('on'); fn(true); }, { passive: false }); el.addEventListener('touchend', e => { e.preventDefault(); el.classList.remove('on'); fn(false); }); el.addEventListener('mousedown', () => fn(true)); el.addEventListener('mouseup', () => fn(false)); };
holdBtn($('bAtk'), on => { if (S.build.on) { if (on) placeBuild(); return; } S.atkHeld = on; if (on) doAttack(); });
holdBtn($('bUse'), on => on && interact());
holdBtn($('bBag'), on => on && togglePanel('bag'));
holdBtn($('bBuild'), on => on && toggleBuild());
function screenToWorld(cx, cy) { return { x: cx * devicePixelRatio / S.scale + S.cam.x, y: cy * devicePixelRatio / S.scale + S.cam.y }; }

// ---------------- actions
function hostileMobs() { const out = []; const sn = S.snaps[S.snaps.length - 1]; if (!sn) return out; for (const r of sn.e.values()) if (r[1] !== 'sheeple_soldier') out.push({ x: r[2], y: r[3] }); return out; }
function doAttack() {
  if (!S.me || S.me.hp <= 0) return;
  const id = held(), it = id && ['weapon', 'tool', 'ranged'].includes(itemDef(id).kind) ? itemDef(id) : D.items.fist;
  const t = performance.now(); if (t - S.lastAtk < it.cooldown) return; S.lastAtk = t;
  let a = S.pos.a;
  if (it.kind === 'ranged' || it.hook) { // gentle auto-aim for thumbs
    let best = null, bd = it.range;
    for (const m of hostileMobs()) { const d = Math.hypot(m.x - S.pos.x, m.y - S.pos.y), ang = Math.atan2(m.y - S.pos.y, m.x - S.pos.x); let df = Math.abs(((ang - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI); if (d < bd && df < 0.7 && !it.hook) { bd = d; best = ang; } }
    if (best !== null) a = best;
  }
  send({ t: 'atk', a });
  S.fx.push({ k: 'swing', id: S.id, a, w: id && it !== D.items.fist ? id : 'fist', t });
}
function nearestInteract() {
  const p = S.pos, opts = [];
  if (!myFl()) for (const n of S.npcs) { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d < 56) opts.push({ d, label: n.shop ? `Shop: ${D.shops[n.shop].name}` : `Talk to ${n.name}`, go: () => n.shop ? openPanel('shop', n.shop) : (toast(`${n.name}: "${n.line}"`)) }); }
  const ptx = Math.floor(p.x / T), pty = Math.floor(p.y / T);
  for (let y = pty - 2; y <= pty + 2; y++) for (let x = ptx - 2; x <= ptx + 2; x++) {
    const c = { x: (x + 0.5) * T, y: (y + 0.5) * T }, d = Math.hypot(c.x - p.x, c.y - p.y);
    const n = myFl() ? null : S.nodeAt.get(K(x, y));
    if (n && n.on && d < 52) {
      const lbl = { pebble: 'Pick up loose rock', fallen_apple: 'Pick up apple (risky!)', loot_chest: 'Open chest', apple_tree: 'Pick an apple', briar: 'Pick red berries (thorny)' }[n.type];
      if (lbl) opts.push({ d, label: lbl, go: () => send({ t: 'use', id: n.id }) });
    }
    const s = objGet(x, y);
    if (s && d < 60) {
      const st = D.structures[s.type];
      if (s.stair === 'up') opts.push({ d, label: 'Climb the stairs', go: () => send({ t: 'stair', sid: s.id }) });
      else if (s.stair === 'down') opts.push({ d, label: 'Go downstairs', go: () => send({ t: 'stair', sid: s.id }) });
      else if (s.type === 'chest') opts.push({ d, label: 'Open chest', go: () => send({ t: 'chest', sid: s.id }) });
      else if (s.type === 'bed') opts.push({ d, label: 'Set respawn at bed', go: () => send({ t: 'bed', sid: s.id }) });
      else if (st.stations) opts.push({ d, label: `Use ${D.items[s.type].name}`, go: () => openPanel('craft') });
    }
  }
  opts.sort((a, b) => a.d - b.d);
  if (opts.length) return opts[0];
  const id = held(), it = id && itemDef(id);
  if (it?.kind === 'food') return { label: `Eat ${it.name}`, go: () => send({ t: 'eat', i: S.me.sel }) };
  if (it?.kind === 'armor') return { label: `Wear ${it.name}`, go: () => send({ t: 'wear', i: S.me.sel }) };
  if (it?.fishing) return { label: 'Cast line (face water)', go: () => send({ t: 'atk', a: S.pos.a }) };
  return null;
}
function interact() { if (S.panel) return closePanel(); const o = nearestInteract(); if (o) o.go(); }
function selectSlot(i) { if (!S.me) return; S.me.sel = i; send({ t: 'sel', i }); refreshHud(); }

// ---------------- build mode
function placeables() { const seen = new Set(), out = []; for (const s of S.me.inv) if (s && D.items[s.id].kind === 'placeable' && !seen.has(s.id)) { seen.add(s.id); out.push(s.id); } return out; }
function toggleBuild() {
  S.build.on = !S.build.on; S.build.manual = false;
  $('buildbar').classList.toggle('hidden', !S.build.on);
  $('bAtk').classList.toggle('place', S.build.on); $('bAtk').textContent = S.build.on ? 'PLACE' : '⚔'; $('bBuild').classList.toggle('on', S.build.on);
  if (S.build.on) { closePanel(); const p = placeables(); if (!p.includes(S.build.item)) S.build.item = p[0] || null; if (!S.build.item) toast('Nothing to build - craft walls, floors, chests... (🎒 > Craft)'); }
  renderBuildbar();
}
function renderBuildbar() {
  if (!S.build.on || !S.me) return;
  const bb = $('buildbar'); bb.innerHTML = '';
  for (const id of placeables()) { const b = document.createElement('button'); b.className = 'slot' + (id === S.build.item ? ' sel' : ''); b.innerHTML = `<img src="${iconUrl(id)}"><span class="n">${count(id)}</span>`; b.title = D.items[id].name; b.onclick = () => { S.build.item = id; renderBuildbar(); }; bb.appendChild(b); }
  for (const [lbl, act] of [['Remove (R)', 'demolish'], ['Upgrade (U)', 'upgrade'], ['Done', 'done']]) { const b = document.createElement('button'); b.className = 'btn'; b.textContent = lbl; b.onclick = () => act === 'done' ? toggleBuild() : buildAction(act); bb.appendChild(b); }
}
function buildTarget() { if (!S.build.manual) { S.build.tx = Math.floor((S.pos.x + Math.cos(S.pos.a) * 30) / T); S.build.ty = Math.floor((S.pos.y - 4 + Math.sin(S.pos.a) * 30) / T); } return { tx: S.build.tx, ty: S.build.ty }; }
function placeBuild() { if (!S.build.item || count(S.build.item) < 1) { S.build.item = placeables()[0] || null; renderBuildbar(); if (!S.build.item) return toast('Nothing to place'); } const { tx, ty } = buildTarget(); send({ t: 'place', id: S.build.item, tx, ty }); }
function buildAction(act) { const { tx, ty } = buildTarget(); const s = objGet(tx, ty) || floorGet(tx, ty); if (!s) return toast('Aim at one of your builds first'); send({ t: act, sid: s.id }); }

// ---------------- HUD + panels
const count = id => S.me.inv.reduce((a, s) => a + (s && s.id === id ? s.n : 0), 0);
function slotHtml(s, i, extra = '') { return `<div class="slot ${extra}" data-i="${i}">${s ? `<img src="${iconUrl(s.id)}" title="${D.items[s.id].name}">${s.n > 1 ? `<span class="n">${s.n}</span>` : ''}` : ''}</div>`; }
function refreshHud() {
  const me = S.me; if (!me) return;
  $('hpbar').style.width = Math.max(0, me.hp) + '%'; $('hptext').textContent = `${Math.max(0, me.hp)} / 100`;
  $('coins').textContent = me.coins;
  $('status').innerHTML = Object.keys(me.status || {}).map(s => `<span class="${s}">${D.status[s]?.name || s}</span>`).join('');
  $('armor').textContent = (me.armor ? '🛡 ' + D.items[me.armor].name : '') + (count('shield') ? '  + Shield' : '');
  const flEl = $('floorLbl'); if (flEl) { const fl = me.fl || 0; flEl.textContent = fl ? `Floor ${fl + 1}` : ''; flEl.classList.toggle('hidden', !fl); }
  $('hotbar').innerHTML = me.inv.slice(0, 6).map((s, i) => slotHtml(s, i, i === me.sel ? 'sel' : '').replace('</div>', `<span class="k">${i + 1}</span></div>`)).join('');
  for (const el of $('hotbar').children) el.onclick = () => selectSlot(+el.dataset.i);
  renderBuildbar();
}
function togglePanel(type) { if (S.panel?.type === type) closePanel(); else openPanel(type); }
function openPanel(type, arg) { S.panel = { type, arg, pick: null }; $('panel').classList.remove('hidden'); refreshPanel(); }
function closePanel() { if (S.panel?.type === 'chest') send({ t: 'cclose' }); S.panel = null; $('panel').classList.add('hidden'); }
function nearStation(st) { for (const s of S.structs.values()) { if ((s.fl || 0) !== myFl()) continue; const d = D.structures[s.type]; if (d.stations?.includes(st) && Math.hypot((s.tx + 0.5) * T - S.pos.x, (s.ty + 0.5) * T - S.pos.y) < 2.8 * T) return true; } return false; }
const STN = { null: 'By hand', table: 'Workbench Table', furnace: 'Furnace / Forge', forge: 'Forge', tinker: "Tinker's Table" };
function refreshPanel() {
  const P = S.panel; if (!P || !S.me) return;
  const head = $('panelHead'), body = $('panelBody'), me = S.me;
  const tabs = P.type === 'shop' ? [['shop', D.shops[P.arg].name]] : P.type === 'chest' ? [['chest', 'Chest storage']] : [['bag', 'Bag'], ['craft', 'Craft']];
  head.innerHTML = tabs.map(([k, l]) => `<button data-k="${k}" class="${P.type === k ? 'on' : ''}">${l}</button>`).join('') + `<button class="x">✕</button>`;
  head.querySelectorAll('button[data-k]').forEach(b => b.onclick = () => openPanel(b.dataset.k, P.arg));
  head.querySelector('.x').onclick = closePanel;
  let h = '';
  if (P.type === 'bag') {
    h += `<div class="info">Tap an item for actions. Slots 1-6 are your hotbar. Armor: ${me.armor ? D.items[me.armor].name + ' <button class="btn" id="unwear">Take off</button>' : 'none'}</div>`;
    h += `<div class="grid">${me.inv.map((s, i) => slotHtml(s, i, (i === P.pick ? 'sel' : '') + (i < 6 ? ' hb' : ''))).join('')}</div>`;
    const s = P.pick != null && me.inv[P.pick];
    if (s) {
      const it = D.items[s.id], stats = [it.dmg ? `dmg ${it.dmg}` : '', it.armor ? `armor ${it.armor}` : '', it.heal ? `heals ${it.heal}` : '', it.power ? 'harvests ' + Object.keys(it.power).join('/') : '', it.ammo ? 'ammo: ' + it.ammo.map(a => D.items[a].name).join(' or ') : '', it.ignoreArmor ? 'ignores armor' : '', it._doc || ''].filter(Boolean).join(' · ');
      h += `<div class="info"><b>${it.name}</b> x${s.n}<br>${stats}<br>`;
      h += `<button class="btn go" data-act="hold">Hold in hand</button> `;
      if (it.kind === 'food') h += `<button class="btn go" data-act="eat">Eat / Use</button> `;
      if (it.kind === 'armor') h += `<button class="btn go" data-act="wear">Wear</button> `;
      if (it.kind === 'placeable') h += `<button class="btn go" data-act="build">Build with it</button>`;
      h += '</div>';
    }
  } else if (P.type === 'craft') {
    const groups = {};
    for (const r of D.recipes) { if (r.melt && !count(r.in && Object.keys(r.in)[0])) continue; (groups[r.station] = groups[r.station] || []).push(r); }
    for (const [st, rs] of Object.entries(groups)) {
      const near = st === 'null' || nearStation(st);
      h += `<div class="sec">${STN[st]}<span class="st ${near ? '' : 'no'}">${st === 'null' ? '' : near ? '✓ nearby' : '✗ not nearby'}</span></div>`;
      for (const r of rs) {
        const can = near && Object.entries(r.in).every(([id, q]) => count(id) >= q) && (!r.requiresBuilt || r.requiresBuilt.every(b => me.built?.includes(b)));
        h += `<div class="row"><img src="${iconUrl(r.out[0])}"><span class="nm">${D.items[r.out[0]].name}${r.out[1] > 1 ? ' x' + r.out[1] : ''}${r.melt ? ' (melt)' : ''}<br>${Object.entries(r.in).map(([id, q]) => `<span class="ing ${count(id) >= q ? '' : 'bad'}"><img src="${iconUrl(id)}">${count(id)}/${q}</span>`).join('')}${r.requiresBuilt ? `<span class="ing ${r.requiresBuilt.every(b => me.built?.includes(b)) ? '' : 'bad'}">needs built: ${r.requiresBuilt.join(' + ')}</span>` : ''}</span><button class="btn go" data-r="${r.id}" ${can ? '' : 'disabled'}>Craft</button></div>`;
      }
    }
  } else if (P.type === 'shop') {
    const sh = D.shops[P.arg];
    h += `<div class="info">${sh.keeper}: "Baa! Have a look." You have ● ${me.coins}</div><div class="sec">Buy</div>`;
    for (const id of sh.sells) { const pr = sh.prices?.[id] ?? D.items[id].buy; h += `<div class="row"><img src="${iconUrl(id)}"><span class="nm">${D.items[id].name}</span>● ${pr} <button class="btn go" data-buy="${id}" ${me.coins >= pr ? '' : 'disabled'}>Buy</button></div>`; }
    h += `<div class="sec">Sell</div>`;
    me.inv.forEach((s, i) => { if (!s) return; const it = D.items[s.id]; if (!it.sell || !(sh.buys === '*' || sh.buys.includes(s.id))) return; h += `<div class="row"><img src="${iconUrl(s.id)}"><span class="nm">${it.name} x${s.n}</span>● ${it.sell} <button class="btn" data-sell="${i}">Sell 1</button></div>`; });
  } else if (P.type === 'chest') {
    const c = S.chest; if (!c) return;
    h += `<div class="info">Shared chest - anyone can use it. Tap to move a stack.</div><div class="sec">Chest</div><div class="grid" id="cg">${c.items.map((s, i) => slotHtml(s, i)).join('')}</div><div class="sec">Your bag</div><div class="grid" id="ig">${me.inv.map((s, i) => slotHtml(s, i)).join('')}</div>`;
  }
  body.innerHTML = h;
  if (P.type === 'bag') {
    body.querySelectorAll('.grid .slot').forEach(el => el.onclick = () => { const i = +el.dataset.i; if (P.pick != null && P.pick !== i && !me.inv[i]) { send({ t: 'swap', a: P.pick, b: i }); P.pick = null; } else P.pick = me.inv[i] ? i : null; refreshPanel(); });
    body.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
      const i = P.pick, a = b.dataset.act;
      if (a === 'hold') { if (i < 6) selectSlot(i); else { send({ t: 'swap', a: i, b: me.sel }); } closePanel(); }
      if (a === 'eat') send({ t: 'eat', i }); if (a === 'wear') send({ t: 'wear', i });
      if (a === 'build') { closePanel(); S.build.item = me.inv[i].id; if (!S.build.on) toggleBuild(); else renderBuildbar(); }
      P.pick = null;
    });
    const uw = $('unwear'); if (uw) uw.onclick = () => send({ t: 'unwear' });
  }
  body.querySelectorAll('[data-r]').forEach(b => b.onclick = () => send({ t: 'craft', r: b.dataset.r, n: 1 }));
  body.querySelectorAll('[data-buy]').forEach(b => b.onclick = () => send({ t: 'buy', shop: P.arg, id: b.dataset.buy }));
  body.querySelectorAll('[data-sell]').forEach(b => b.onclick = () => send({ t: 'sell', shop: P.arg, i: +b.dataset.sell }));
  if (P.type === 'chest') { body.querySelectorAll('#cg .slot').forEach(el => el.onclick = () => send({ t: 'ctake', sid: S.chest.sid, i: +el.dataset.i })); body.querySelectorAll('#ig .slot').forEach(el => el.onclick = () => send({ t: 'cput', sid: S.chest.sid, i: +el.dataset.i })); }
}

// ---------------- minimap
let mini;
const TILE_COL = ['#68b24c', '#62aa48', '#78b85a', '#c4a470', '#3e78c8', '#e2ce96', '#96928c', '#96704a', '#54963e', '#4a4634', '#96683c', '#7a5a34', '#70ba54', '#5a96e6', '#3a6230'];
function buildMinimap() {
  mini = document.createElement('canvas'); mini.width = S.W; mini.height = S.H; const g = mini.getContext('2d'), im = g.createImageData(S.W, S.H);
  for (let i = 0; i < S.tiles.length; i++) { const c = TILE_COL[S.tiles[i]] || '#000', o = i * 4; im.data[o] = parseInt(c.slice(1, 3), 16); im.data[o + 1] = parseInt(c.slice(3, 5), 16); im.data[o + 2] = parseInt(c.slice(5, 7), 16); im.data[o + 3] = 255; if (S.blocked.has(i)) { im.data[o] = 120; im.data[o + 1] = 60; im.data[o + 2] = 40; } }
  for (const n of S.nodes) { const c = n && D.nodes?.[n.type]?.mapColor; if (!c) continue; const o = (n.ty * S.W + n.tx) * 4; im.data[o] = parseInt(c.slice(1, 3), 16); im.data[o + 1] = parseInt(c.slice(3, 5), 16); im.data[o + 2] = parseInt(c.slice(5, 7), 16); }
  g.putImageData(im, 0, 0);
  const mm = $('minimap'); mm.width = S.W; mm.height = S.mainH;   // interior rooms (strip below the map) stay off the minimap
}
function drawMinimap(players) {
  const g = $('minimap').getContext('2d'); g.drawImage(mini, 0, 0);
  const fl = myFl();
  if (fl) {
    g.fillStyle = '#1a1520'; g.fillRect(0, 0, S.W, S.mainH);
    g.fillStyle = '#3a3048';
    for (const h of S.houses) for (const k of (h.floors[fl] || h.floors[String(fl)] || [])) { const [x, y] = k.split(',').map(Number); g.fillRect(x, y, 1, 1); }
  } else {
    g.fillStyle = '#000'; for (const d of S.dens) if (!S.sealed.has(d.id) && !objGet(d.tx, d.ty, 0) && !floorGet(d.tx, d.ty, 0)) g.fillRect(d.tx - 1, d.ty - 1, 2, 2);
  }
  g.fillStyle = '#c08040'; for (const s of S.structs.values()) if ((s.fl || 0) === fl) g.fillRect(s.tx, s.ty, 1, 1);
  g.fillStyle = '#fff'; for (const p of players) g.fillRect(Math.floor(p.x / T) - 1, Math.floor(p.y / T) - 1, 3, 3);
  g.fillStyle = '#ffd84a'; g.fillRect(Math.floor(S.pos.x / T) - 1, Math.floor(S.pos.y / T) - 1, 3, 3);
}

// ---------------- main loop
let last = performance.now();
function update(dt) {
  if (!S.me) return;
  let dx = (S.keys.d || S.keys.arrowright ? 1 : 0) - (S.keys.a || S.keys.arrowleft ? 1 : 0), dy = (S.keys.s || S.keys.arrowdown ? 1 : 0) - (S.keys.w || S.keys.arrowup ? 1 : 0);
  if (S.joy.x || S.joy.y) { dx = S.joy.x; dy = S.joy.y; }
  const mag = Math.hypot(dx, dy); S.moving = mag > 0.15 && !S.panel && S.me.hp > 0;
  if (S.moving) {
    const k = Math.min(1, mag) / mag * SPEED * dt; S.pos.a = Math.atan2(dy, dx);
    const nx = S.pos.x + dx * k, ny = S.pos.y + dy * k;
    if (!blockedAt(nx, S.pos.y, PR)) S.pos.x = nx;
    if (!blockedAt(S.pos.x, ny, PR)) S.pos.y = ny;
  }
  if ((S.keys[' '] || S.atkHeld || S.mouseHeld) && !S.panel) { if (S.build.on) { if (S.keys[' '] && !S.spaceLatch) { S.spaceLatch = true; placeBuild(); } } else doAttack(); }
  if (!S.keys[' ']) S.spaceLatch = false;
  const t = performance.now();
  if (t - S.lastSend > 66 && (S.moving || t - S.lastSend > 500)) { S.lastSend = t; send({ t: 'mv', x: Math.round(S.pos.x * 10) / 10, y: Math.round(S.pos.y * 10) / 10, a: S.pos.a, s: S.pos.s, m: S.moving ? 1 : 0 }); }
  // prompt
  const o = S.build.on ? null : nearestInteract();
  const pr = $('prompt'); if (o && !S.panel) { pr.textContent = (isTouch ? '✋ ' : 'E: ') + o.label; pr.classList.remove('hidden'); } else pr.classList.add('hidden');
}
function interpEntities() {
  const rt = performance.now() - INTERP, sn = S.snaps; const out = { p: [], e: [], b: [] };
  if (!sn.length) return out;
  let a = sn[0], b = sn[sn.length - 1];
  for (let i = sn.length - 1; i > 0; i--) if (sn[i - 1].t <= rt) { a = sn[i - 1]; b = sn[i]; break; }
  const f = b.t > a.t ? Math.max(0, Math.min(1, (rt - a.t) / (b.t - a.t))) : 1;
  const lerp = (ra, rb, o) => ra ? { x: ra[o] + (rb[o] - ra[o]) * f, y: ra[o + 1] + (rb[o + 1] - ra[o + 1]) * f } : { x: rb[o], y: rb[o + 1] };
  const fl = myFl();
  for (const [id, r] of b.p) { if (id === S.id) { out.me = r; continue; } if ((r[10] || 0) !== fl) continue; const q = lerp(a.p.get(id), r, 1); out.p.push({ id, x: q.x, y: q.y, ang: r[3] / 100, hp: r[4], held: r[5], name: r[6], armor: r[7], st: r[8], mv: r[9] }); }
  if (!fl) {
    for (const [id, r] of b.e) { const q = lerp(a.e.get(id), r, 2); out.e.push({ id, type: r[1], x: q.x, y: q.y, ang: r[4] / 100, hp: r[5], state: r[6], mv: r[7] }); }
    out.b = sn[sn.length - 1].b;
  }
  return out;
}
const NODE_FRAME_OFF = { tree: 1, apple_tree: 2, boulder: 1, iron_node: 1, briar: 2, loot_chest: 1 };
// nodes can list several sprite variants (tree families, ruin pieces, thickets); pick one per tile, stable across clients
const hash2 = (x, y) => { let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) | 0; h = Math.imul(h ^ h >>> 13, 1274126177); return (h ^ h >>> 16) >>> 0; };
function nodeSprite(n) {
  if (n.spr) return n.spr;
  const list = (D.nodes?.[n.type]?.sprites || []).filter(k => MAN.sprites[k]);
  return n.spr = list.length ? list[hash2(n.tx, n.ty) % list.length] : n.type;
}
function drawNode(n, x, y) {
  const key = nodeSprite(n), nd = D.nodes?.[n.type] || {}, by = (y + 1) * T - 3;
  if (n.on) return spr(key, 0, 0, (x + 0.5) * T, by);
  const off = NODE_FRAME_OFF[n.type];
  if (off !== undefined && (MAN.sprites[key]?.cols || 1) > off) return spr(key, off, 0, (x + 0.5) * T, by);
  if (nd.harvest === 'tree' && !nd.ruin && MAN.sprites.tree?.cols > 1) spr('tree', 1, 0, (x + 0.5) * T, by);   // stump
}
function denSprite(d) {
  if (d.spr) return d.spr;
  const v = Object.keys(MAN.sprites).filter(k => /^den_v\d+$/.test(k));
  return d.spr = MAN.sprites['den_' + d.region] ? 'den_' + d.region : v.length && hash2(d.tx, d.ty) % (v.length + 1) ? v[hash2(d.tx, d.ty) % v.length] : 'den';
}
function render() {
  const dpr = devicePixelRatio || 1, W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  ctx.imageSmoothingEnabled = false; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#1d2618'; ctx.fillRect(0, 0, W, H);
  if (!S.me || !MAN) return;
  const sc = S.scale = Math.max(1, Math.round(Math.min(W, H) / ((+new URLSearchParams(location.search).get('view') || 12) * T)));
  const vw = W / sc, vh = H / sc;
  S.cam = { x: Math.round((S.pos.x - vw / 2) * sc) / sc, y: Math.round((S.pos.y - 12 - vh / 2) * sc) / sc };
  ctx.setTransform(sc, 0, 0, sc, -S.cam.x * sc, -S.cam.y * sc);
  const x0 = Math.max(0, Math.floor(S.cam.x / T)), y0 = Math.max(0, Math.floor(S.cam.y / T)), x1 = Math.min(S.W - 1, Math.ceil((S.cam.x + vw) / T)), y1 = Math.min(S.H - 1, Math.ceil((S.cam.y + vh) / T));
  const tsI = IMG.tiles, now = performance.now(), fl = myFl();
  if (fl) {
    ctx.fillStyle = '#14101c';
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ctx.fillRect(x * T, y * T, T, T);
    ctx.fillStyle = '#2a2436';
    for (const h of S.houses) for (const k of (h.floors[fl] || h.floors[String(fl)] || [])) {
      const [x, y] = k.split(',').map(Number);
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        if (MAN.sprites.floor_wood) spr('floor_wood', 0, 0, x * T, y * T, 0.45);
        else ctx.fillRect(x * T, y * T, T, T);
      }
    }
  } else {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = S.tiles[y * S.W + x], gk = MAN.ground?.[t];   // imported ground sheets: 16 variants, picked per tile
      if (gk && MAN.sprites[gk]) spr(gk, hash2(x, y) % MAN.sprites[gk].cols, 0, x * T, y * T); else ctx.drawImage(tsI, t * T, 0, T, T, x * T, y * T, T, T);
    }
    for (const d of S.dens) if (d.tx >= x0 - 1 && d.tx <= x1 + 1 && d.ty >= y0 - 1 && d.ty <= y1 + 1) spr(denSprite(d), 0, 0, (d.tx + 0.5) * T, (d.ty + 0.5) * T);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const n = S.nodeAt.get(K(x, y)); if (n && n.on && D.nodes?.[n.type]?.floor) spr(nodeSprite(n), 0, 0, x * T, y * T); }
  }
  for (const s of S.floorAt.values()) if ((s.fl || 0) === fl && s.tx >= x0 && s.tx <= x1 && s.ty >= y0 && s.ty <= y1) spr(s.type, 0, 0, s.tx * T, s.ty * T);
  const E = interpEntities(), list = [];
  for (let y = y0 - 1; y <= y1 + 2; y++) for (let x = x0 - 1; x <= x1 + 1; x++) {
    if (!fl) { const n = S.nodeAt.get(K(x, y)); if (n && !D.nodes?.[n.type]?.floor) list.push({ y: (y + 1) * T - 3, d: () => drawNode(n, x, y) }); }
    const s = objGet(x, y, fl); if (s) list.push({ y: (y + 1) * T - 1, d: () => { spr(s.type, 0, 0, (x + 0.5) * T, (y + 1) * T - 1); const mx = D.structures[s.type].hp; if (s.hp < mx) bar((x + 0.5) * T, y * T - 10, s.hp / mx, '#e0a040'); } });
  }
  if (!fl) {
    for (const b of S.buildings) list.push({ y: (b.ty + b.h) * T, d: () => { const s = MAN.sprites[b.sprite]; spr(b.sprite, 0, 0, s && s.anchor[0] ? (b.tx + b.w / 2) * T : b.tx * T, (b.ty + b.h) * T); } });   // imported art is bottom-centred on its footprint
    for (const n of S.npcs) list.push({ y: n.y, d: () => { const ph = ((now + n.x * 7) % 9000) / 1500; drawChar(n.sprite, n.x, n.y, Math.PI / 2, false, 0, ph < 1 ? 'emote' : null, ph); label(n.x, n.y - spriteTop(n.sprite) - 6, n.name, n.shop ? '#ffd84a' : '#ddf'); } });
  }
  const frame = (mv, id) => mv ? 1 + ((now / 140 + id) | 0) % 3 : 0;
  const drawPlayer = (x, y, ang, mv, name, hp, held, id, st, isMe) => {
    drawChar('player', x, y, ang, mv, id);
    if (held && D.items[held]) { const ox = Math.cos(ang) * 9, oy = Math.sin(ang) * 4; ctx.drawImage(ICON[held], Math.round(x + ox - 6 + (dirRow(ang) === 1 ? -4 : 4)), Math.round(y - 18 + oy), 12, 12); }
    const top = spriteTop('player');
    label(x, y - top - 7, name, isMe ? '#ffd84a' : '#fff'); if (hp < 100) bar(x, y - top - 4, hp / 100, '#e04040');
    if (st) label(x, y - top - 15, st.includes('poison') ? '☠' : '🐛', '#9f9');
  };
  for (const p of E.p) list.push({ y: p.y, d: () => drawPlayer(p.x, p.y, p.ang, p.mv, p.name, p.hp, p.held, p.id, p.st) });
  list.push({ y: S.pos.y, d: () => drawPlayer(S.pos.x, S.pos.y, S.pos.a, S.moving, S.me.name, S.me.hp, held(), S.id, Object.keys(S.me.status || {}).join(','), true) });
  for (const m of E.e) list.push({ y: m.y, d: () => {
    const ms = S.mobSt[m.id] || (S.mobSt[m.id] = { state: m.state, since: now }); if (ms.state !== m.state) { ms.state = m.state; ms.since = now; }
    const hasAtk = MAN.sprites[m.type]?.anims?.attack, bite = S.mobBite[m.id];
    let role = null, prog = 0, shake = 0;
    if (m.state === 'windup' || m.state === 'honk') { if (hasAtk) { role = 'attack'; prog = Math.min(0.99, (now - ms.since) / 600); } else shake = Math.sin(now / 30) * 1.5; }
    else if (m.state === 'charge' && hasAtk) { role = 'attack'; prog = 0.7 + 0.2 * (((now / 120) | 0) % 2); }
    else if (bite && now - bite < 450 && hasAtk) { role = 'attack'; prog = (now - bite) / 450; }
    drawChar(m.type, m.x + shake, m.y, m.ang, m.mv || m.state === 'charge', m.id, role, prog);
    if (D.mobs[m.type]?.boss && Math.hypot(m.x - S.pos.x, m.y - S.pos.y) < 380) { S.bossSeen = { m, at: now }; label(m.x, m.y - spriteTop(m.type) - 8, D.mobs[m.type].name, '#ff9040'); }
    const mx = D.mobs[m.type]?.hp || 40; if (m.hp < mx) bar(m.x, m.y - spriteTop(m.type) - 4, m.hp / mx, m.type === 'sheeple_soldier' ? '#60c060' : '#e04040');
  } });
  list.sort((a, b) => a.y - b.y); for (const o of list) o.d();
  // projectiles
  const PI = { bullet: 0, note: 1, arrow: 2, bolt: 3, ball: 4 };
  for (const b of E.b || []) { ctx.save(); ctx.translate(b[2], b[3]); if (b[1] !== 'note') ctx.rotate(b[4] / 100); spr('projectiles', PI[b[1]] ?? 0, 0, 0, 0); ctx.restore(); }
  // fx
  S.fx = S.fx.filter(f => now - f.t < (f.until ? f.until - f.t : 900));
  for (const f of S.fx) {
    const k = (now - f.t) / 900;
    if (f.k === 'text') { ctx.globalAlpha = 1 - k; label(f.x, f.y - k * 24, f.text, f.color); ctx.globalAlpha = 1; }
    else if (f.k === 'swing') {
      if (now - f.t > 220) continue; const who = f.id === S.id ? S.pos : E.p.find(p => p.id === f.id); if (!who) continue;
      const it = D.items[f.w] || D.items.fist; if (it.kind === 'ranged') continue;
      const prog = (now - f.t) / 220, ang = f.a - 1 + prog * 2, r = Math.min(it.range, 40) * 0.7;
      ctx.save(); ctx.translate(who.x + Math.cos(ang) * r, who.y - 10 + Math.sin(ang) * r); ctx.rotate(ang + Math.PI / 4); ctx.drawImage(ICON[f.w] || ICON.fist, -8, -8, 16, 16); ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(who.x, who.y - 10, r, f.a - 1, ang); ctx.stroke();
    } else if (f.k === 'poof') { ctx.fillStyle = f.c || '#fff'; ctx.globalAlpha = 1 - k; for (let i = 0; i < 6; i++) { const a = i * 1.05; ctx.beginPath(); ctx.arc(f.x + Math.cos(a) * k * 18, f.y - 10 + Math.sin(a) * k * 18, 5 * (1 - k) + 1, 0, 7); ctx.fill(); } ctx.globalAlpha = 1; }
    else if (f.k === 'shock') { ctx.strokeStyle = `rgba(255,230,140,${1 - k})`; ctx.lineWidth = 3 * (1 - k) + 1; ctx.beginPath(); ctx.ellipse(f.x, f.y - 6, f.r * Math.min(1, k * 2.5), f.r * 0.6 * Math.min(1, k * 2.5), 0, 0, 7); ctx.stroke(); }
    else if (f.k === 'chip') { ctx.fillStyle = '#d8c090'; for (let i = 0; i < 4; i++) ctx.fillRect(f.x + Math.cos(i * 1.6) * k * 14, f.y - 8 + Math.sin(i * 1.6) * k * 14 + k * k * 10, 2, 2); }
    else if (f.k === 'hook') { if (k > 0.35) continue; ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(f.x, f.y - 10); ctx.lineTo(f.x + Math.cos(f.a) * f.len, f.y - 10 + Math.sin(f.a) * f.len); ctx.stroke(); }
    else if (f.k === 'cast') { const bx = f.x + Math.cos(f.a) * 56, by = f.y + Math.sin(f.a) * 56; ctx.strokeStyle = '#eee'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(f.x, f.y - 16); ctx.lineTo(bx, by); ctx.stroke(); ctx.fillStyle = '#e33'; ctx.fillRect(bx - 1, by - 1 + Math.sin(now / 200) * 1.5, 3, 3); }
  }
  // build ghost
  if (S.build.on && S.build.item) {
    const { tx, ty } = buildTarget(); const near = Math.hypot((tx + 0.5) * T - S.pos.x, (ty + 0.5) * T - S.pos.y) < 3.6 * T;
    const lay = D.structures[S.build.item].layer;
    const occupied = !!(lay === 'floor' ? floorGet(tx, ty) : objGet(tx, ty));
    const ok = near && !occupied && (fl ? inFootprint(fl, tx, ty) && !tileSolid(tx, ty) : !S.nodeAt.has(K(tx, ty)) && !tileSolid(tx, ty) && !(tx >= S.town.x0 && tx <= S.town.x1 && ty >= S.town.y0 && ty <= S.town.y1));
    if (lay === 'floor') spr(S.build.item, 0, 0, tx * T, ty * T, 0.55); else spr(S.build.item, 0, 0, (tx + 0.5) * T, (ty + 1) * T - 1, 0.55);
    ctx.strokeStyle = ok ? '#7f7' : '#f55'; ctx.lineWidth = 1; ctx.strokeRect(tx * T + 0.5, ty * T + 0.5, T - 1, T - 1);
  }
  // boss health bar (screen space)
  if (S.bossSeen && now - S.bossSeen.at < 300) { const m = S.bossSeen.m, def = D.mobs[m.type], bw = Math.min(W * 0.7, 520 * dpr), bx = (W - bw) / 2, by = 64 * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#000a'; ctx.fillRect(bx - 4, by - 4, bw + 8, 22 * dpr); ctx.fillStyle = '#5a1010'; ctx.fillRect(bx, by, bw, 10 * dpr); ctx.fillStyle = '#e04030'; ctx.fillRect(bx, by, bw * Math.max(0, m.hp / def.hp), 10 * dpr);
    ctx.font = `bold ${9 * dpr}px monospace`; ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.fillText(def.name.toUpperCase(), W / 2, by + 9 * dpr); }
  drawMinimap(E.p);
}
function label(x, y, text, color) { ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#000'; ctx.fillText(text, x + 0.5, y + 0.5); ctx.fillStyle = color; ctx.fillText(text, x, y); }
function bar(x, y, f, c) { ctx.fillStyle = '#000'; ctx.fillRect(x - 11, y, 22, 3); ctx.fillStyle = c; ctx.fillRect(x - 10, y + 1, Math.max(0, 20 * f), 1); }
function loop() { const t = performance.now(), dt = Math.min(0.05, (t - last) / 1000); last = t; update(dt); render(); requestAnimationFrame(loop); }

// ---------------- boot / lobby
$('name').value = localStorage.getItem('sheeple_name') || '';
const QS = new URLSearchParams(location.search);
const getName = () => { const n = $('name').value.trim(); if (!n) { $('joinErr').textContent = 'Pick a name first'; $('name').focus(); return null; } localStorage.setItem('sheeple_name', n); $('joinErr').textContent = ''; return n; };
function setLobbyBusy(b, text) { document.querySelectorAll('#join button').forEach(x => x.disabled = b); if (text) $('joinErr').textContent = text; }
const go = () => { const n = getName(); if (n) connect(n); };
$('joinBtn').onclick = go; $('name').addEventListener('keydown', e => { if (e.key === 'Enter') (STATIC ? ($('joinSec').classList.contains('hidden') ? hostGo() : QS.get('room') ? joinGo() : null) : go()); });

// static (GitHub Pages) lobby: host a world in this tab, or join a friend's room
const roomOf = v => (v || '').toUpperCase().replace(/^.*[?&]ROOM=/, '').replace(/[^A-Z0-9]/g, '').slice(0, 8);
function joinGo() { const n = getName(); const code = roomOf($('roomCode').value); if (!n) return; if (!code) { $('joinErr').textContent = 'Enter a room code'; return; } NET.mode = 'join'; NET.room = code; setLobbyBusy(true, `Connecting to room ${code}...`); connect(n); }
async function refreshSlots(select) {
  const ws_ = (await Host.listWorlds()).sort((a, b) => (b.updated || 0) - (a.updated || 0)), sel = $('slot');
  sel.innerHTML = ws_.map(w => `<option value="${encodeURIComponent(w.name)}">${w.name.replace(/</g, '&lt;')} (room ${w.code})</option>`).join('') + '<option value="">+ New world...</option>';
  if (select !== undefined) sel.value = encodeURIComponent(select); else if (!ws_.length) sel.value = '';
  $('newWorld').classList.toggle('hidden', sel.value !== ''); $('exportBtn').disabled = $('delBtn').disabled = sel.value === '';
}
async function hostGo() {
  const n = getName(); if (!n) return;
  let slot = decodeURIComponent($('slot').value);
  if (!slot) { slot = $('worldName').value.trim() || 'My world'; if ((await Host.listWorlds()).some(w => w.name === slot)) { $('joinErr').textContent = 'A world with that name already exists'; return; } }
  setLobbyBusy(true, 'Building the world...');
  try {
    NET.mode = 'host'; NET.client = await Host.startHosting(slot, { seed: +$('worldSeed').value || 0, test: QS.get('test') === '1' });
    history.replaceState(null, '', location.pathname + '?room=' + Host.H.code + (QS.get('test') ? '&test=1' : ''));
    $('hostBadge').classList.remove('hidden'); Host.H.onStatus = hostBadge; hostBadge(); setInterval(hostBadge, 1000);
    connect(n);
  } catch (e) { console.error(e); setLobbyBusy(false, 'Could not start the world: ' + e.message); }
}
function hostBadge() {
  const n = Host.playerCount(), st = Host.H.status;
  $('hostTxt').innerHTML = `Hosting: room <b>${Host.H.code}</b>, ${n} player${n === 1 ? '' : 's'}` + (st !== 'online' ? ` <i>(${st})</i>` : '') + '<small>Keep this tab open: the world is offline when it closes</small>';
}
async function share() {
  const url = Host.shareUrl(), text = `Join my Meadowcraft world! Room code ${Host.H.code}`;
  try { if (navigator.share && isTouch) return await navigator.share({ title: 'Meadowcraft', text, url }); } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied: ' + url); } catch { prompt('Send this link to your friends:', url); }
}
if (STATIC) {
  document.body.classList.add('static');
  $('joinBtn').classList.add('hidden'); $('p2p').classList.remove('hidden');
  $('hostBtn').onclick = hostGo; $('roomBtn').onclick = joinGo; $('shareBtn').onclick = share;
  $('roomCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinGo(); });
  $('slot').onchange = () => refreshSlots(decodeURIComponent($('slot').value));
  $('exportBtn').onclick = () => Host.exportWorld(decodeURIComponent($('slot').value));
  $('delBtn').onclick = async () => { const s = decodeURIComponent($('slot').value); if (s && confirm(`Delete the world "${s}" from this browser? Export it first if you want a backup.`)) { await Host.deleteWorld(s); localStorage.removeItem('mc_backup_' + s); refreshSlots(); } };
  $('importFile').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const name = await Host.importWorld(f); await refreshSlots(name); toast('Imported ' + name); } catch (err) { $('joinErr').textContent = err.message; } e.target.value = ''; };
  $('showHost').onclick = () => { $('hostSec').classList.remove('hidden'); $('showHost').classList.add('hidden'); };
  const room = roomOf(QS.get('room'));
  if (room) { $('roomCode').value = room; $('roomBtn').textContent = `Join room ${room}`; $('hostSec').classList.add('hidden'); $('showHost').classList.remove('hidden'); }
  refreshSlots().then(async () => {
    const mine = room && (await Host.listWorlds()).find(w => w.code === room);
    if (mine) { // this browser hosts that room (e.g. the host reloaded): offer to resume instead of joining a dead room
      await refreshSlots(mine.name); $('hostSec').classList.remove('hidden'); $('joinSec').classList.add('hidden'); $('showHost').classList.add('hidden');
      $('hostBtn').textContent = `Resume hosting room ${room}`;
    }
  }).catch(e => { $('joinErr').textContent = 'Saving is unavailable in this browser (private mode?): ' + e.message; });
}
loadAssets().then(() => { requestAnimationFrame(loop); const q = QS.get('name'); if (q) { $('name').value = q; if (!STATIC) go(); } });
