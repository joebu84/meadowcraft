// Transport layer. The game client only ever sees a ws-like object: { readyState, send(str), close(), onopen, onmessage({data}), onclose }.
//  - Node server build: a real WebSocket to /ws.
//  - Static (GitHub Pages) build: PeerJS WebRTC data channel to the host's browser, or an in-tab loopback when you ARE the host.
export const STATIC = !!window.MEADOW_STATIC;
export const PEER_PREFIX = 'meadowcraft-v1-';
export const ICE = { iceServers: [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  // free public TURN relay (helps phones on cellular / strict NATs); best effort, may be rate limited
  { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
] };
const CHUNK = 48000;   // data channels choke on big messages (the welcome packet), so split them
export function chunker(sendRaw) {
  let cid = 0;
  return s => { if (s.length <= CHUNK) return sendRaw(s); const id = ++cid, n = Math.ceil(s.length / CHUNK); for (let i = 0; i < n; i++) sendRaw('\u0001' + JSON.stringify({ c: id, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) })); };
}
export function dechunker(onWhole) {
  const parts = new Map();
  return raw => { if (typeof raw !== 'string') raw = String(raw); if (raw[0] !== '\u0001') return onWhole(raw);
    const m = JSON.parse(raw.slice(1)); let p = parts.get(m.c); if (!p) parts.set(m.c, p = []); p[m.i] = m.d;
    if (p.filter(x => x !== undefined).length === m.n) { parts.delete(m.c); onWhole(p.join('')); } };
}
// wrap a PeerJS DataConnection as the server-side conn the game core expects (conn.on('message'|'close'))
export function serverConnFromPeer(dc) {
  const ls = { message: [], close: [] }; let closed = false;
  const fireClose = () => { if (closed) return; closed = true; ls.close.forEach(f => f()); };
  const sendC = chunker(s => { try { dc.send(s); } catch {} });
  dc.on('data', dechunker(s => ls.message.forEach(f => f(s))));
  dc.on('close', fireClose); dc.on('error', fireClose);
  return { get readyState() { return dc.open && !closed ? 1 : 3; }, send: sendC, close: () => { try { dc.close(); } catch {} fireClose(); }, on: (ev, f) => ls[ev] && ls[ev].push(f) };
}
// in-tab pair for the host's own player: [serverSide, clientSide]
export function loopback() {
  const ls = { message: [], close: [] }; let open = true;
  const client = { readyState: 1, onopen: null, onmessage: null, onclose: null,
    send: s => open && queueMicrotask(() => ls.message.forEach(f => f(s))),
    close: () => { if (!open) return; open = false; client.readyState = 3; ls.close.forEach(f => f()); client.onclose && client.onclose(); } };
  const server = { get readyState() { return open ? 1 : 3; }, send: s => open && queueMicrotask(() => client.onmessage && client.onmessage({ data: s })), close: () => client.close(), on: (ev, f) => ls[ev] && ls[ev].push(f) };
  setTimeout(() => client.onopen && client.onopen(), 0);
  return [server, client];
}
// joiner: connect to a host's room code over PeerJS; returns a ws-like client
let joinPeer = null;
function getJoinPeer() {
  return new Promise((res, rej) => {
    if (joinPeer && !joinPeer.destroyed) { if (joinPeer.open) return res(joinPeer); if (joinPeer.disconnected) joinPeer.reconnect(); joinPeer.once('open', () => res(joinPeer)); return; }
    joinPeer = new window.Peer({ config: ICE, debug: 1 });
    const t = setTimeout(() => rej(new Error('Could not reach the matchmaking server')), 15000);
    joinPeer.once('open', () => { clearTimeout(t); res(joinPeer); });
    joinPeer.on('error', e => { if (e.type === 'peer-unavailable') joinPeer.emit('room-missing'); });
  });
}
export function joinRoom(code) {
  const ws = { readyState: 0, onopen: null, onmessage: null, onclose: null, send: () => {}, close: () => {} };
  let done = false; const finish = why => { if (done) return; done = true; ws.readyState = 3; ws.closeReason = why; ws.onclose && ws.onclose({ reason: why }); };
  getJoinPeer().then(peer => {
    const dc = peer.connect(PEER_PREFIX + code.toUpperCase(), { reliable: true, serialization: 'raw' });
    const t = setTimeout(() => { if (!dc.open) { try { dc.close(); } catch {} finish('timeout'); } }, 15000);
    const missing = () => finish('no-host'); peer.once('room-missing', missing);
    const sendC = chunker(s => { try { dc.send(s); } catch {} });
    dc.on('open', () => { clearTimeout(t); peer.off('room-missing', missing); ws.readyState = 1; ws.send = sendC; ws.close = () => { try { dc.close(); } catch {} finish('closed'); }; ws.onopen && ws.onopen(); });
    dc.on('data', dechunker(s => ws.onmessage && ws.onmessage({ data: s })));
    dc.on('close', () => finish('closed')); dc.on('error', () => finish('error'));
  }).catch(e => finish(e.message));
  return ws;
}
export function openWebSocket() { return new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + location.pathname.replace(/[^/]*$/, '') + 'ws'); }
