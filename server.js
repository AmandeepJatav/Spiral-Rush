/* ============================================================
   SPIRAL RUSH — server (multiplayer + full competitive platform)
   ------------------------------------------------------------
   Multiplayer rooms (2–3), shared seed, finish order, reconnect,
   play-again, dynamic difficulty + persistent platform:
   profiles, scores, pro ranks, all leaderboards (real-time),
   daily maze + server ghosts, friends (request flow),
   limited-time events, notifications, rewards, customization.
   ============================================================ */
'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const store = require('./lib/store');
const platform = require('./lib/platform');
const SC = require('./lib/scoring');
const EV = require('./lib/events');

const log = require('./lib/log');
const rateLimiter = require('./lib/ratelimit');
const integrity = require('./lib/integrity');

store.load();
const DB = () => store.db();

const app = express();
app.disable('x-powered-by');

/* ---- security headers (no extra deps) ---- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  next();
});

/* ---- health & readiness probes (load balancers / k8s / uptime) ---- */
const STARTED_AT = Date.now();
function healthPayload() {
  return {
    status: 'ok', uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    players: Object.keys(DB().players).length, rooms: Object.keys(rooms).length,
    online: Object.keys(sockByCid).length, version: require('./package.json').version,
  };
}
app.get('/health', (req, res) => res.json(healthPayload()));
app.get('/healthz', (req, res) => res.json(healthPayload()));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

const server = http.createServer(app);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,            // 1 MB cap per message (anti-abuse)
  pingTimeout: 20000,
});

/* ---------------- rooms ---------------- */
const COLORS = ['#56c23a', '#4a86e8', '#7d5bd6', '#ff8c42'];   // 4th color for private rooms
const MAX = 3, MIN = 2, LOBBY_MS = 7000, GRACE = 60000;
const PRIV_MAX = 4, PRIV_MIN = 2;                               // private rooms allow 4 players
let rooms = {}, roomSeq = 1;
let privateCodes = {};                                           // code -> roomId lookup
const randSeed = () => (Math.floor(Math.random() * 0x7fffffff)) >>> 0;
const todayKey = () => SC.dayKey(new Date());
const activeEvent = () => EV.activeEvent(new Date());

/* generate a unique 6-char room code (uppercase) */
function makeCode() {
  let code;
  do { code = Math.random().toString(36).slice(2, 8).toUpperCase(); }
  while (privateCodes[code]);
  return code;
}

function makeRoom(isPrivate = false, code = null, target = 3) {
  const id = 'room' + (roomSeq++);
  rooms[id] = {
    id, level: 1, seed: 0, state: 'lobby',
    players: {}, order: [], lobbyTimer: null, finishCount: 0,
    private: isPrivate, code: code || null,
    target: isPrivate ? PRIV_MAX : Math.max(MIN, Math.min(MAX, target)),  // 2 or 3 for public
  };
  if (isPrivate && code) privateCodes[code] = id;
  return rooms[id];
}
function makePrivateRoom() {
  const code = makeCode();
  return makeRoom(true, code, PRIV_MAX);
}
function connCount(r) { return Object.values(r.players).filter(p => p.connected).length; }
function openRoom(target = 3) {
  // only match into public rooms with SAME target player count
  for (const id in rooms) {
    const r = rooms[id];
    if (!r.private && r.state === 'lobby' && r.target === target && Object.keys(r.players).length < r.target) return r;
  }
  return makeRoom(false, null, target);
}
function roomList(r) { return r.order.filter(c => r.players[c]).map(c => { const p = r.players[c]; return { id: c, name: p.name, color: p.color, avatar: p.avatar, progress: p.progress, finished: p.finished, place: p.place, solveTime: p.solveTime || null, connected: p.connected }; }); }
function broadcast(r) { io.to(r.id).emit('players', { state: r.state, level: r.level, players: roomList(r), private: r.private, code: r.code }); }

function startLobby(r) {
  if (r.state !== 'lobby') return;
  const count = Object.keys(r.players).length;

  if (r.private) {
    // private rooms: start when cap hit, or countdown when >= PRIV_MIN
    if (count >= PRIV_MAX) return startRound(r);
    if (count >= PRIV_MIN && !r.lobbyTimer) {
      io.to(r.id).emit('lobby', { count, target: PRIV_MAX, endsIn: LOBBY_MS, private: true, code: r.code });
      r.lobbyTimer = setTimeout(() => startRound(r), LOBBY_MS);
    } else {
      io.to(r.id).emit('lobby', { count, target: PRIV_MAX, private: true, code: r.code });
    }
    return;
  }

  // PUBLIC rooms: start ONLY when exact target is met. No partial countdown.
  if (count >= r.target) {
    return startRound(r);
  }
  // still waiting — broadcast status with target info
  if (r.lobbyTimer) { clearTimeout(r.lobbyTimer); r.lobbyTimer = null; }
  io.to(r.id).emit('lobby', { count, target: r.target });
}
function startRound(r) {
  if (r.lobbyTimer) { clearTimeout(r.lobbyTimer); r.lobbyTimer = null; }
  const floor = r.private ? PRIV_MIN : r.target;  // public = exact target, private = 2 min
  if (connCount(r) < floor) { r.state = 'lobby'; return startLobby(r); }
  r.state = 'playing'; r.seed = randSeed(); r.finishCount = 0; r.startedAt = Date.now();
  for (const c in r.players) { const p = r.players[c]; p.progress = 0; p.finished = false; p.place = 0; p.ready = false; p.recorded = false; p.solveTime = null; }
  io.to(r.id).emit('start', { seed: r.seed, level: r.level, players: roomList(r), private: r.private, target: r.target });
  broadcast(r);
}
function checkRoundOver(r) {
  if (r.state !== 'playing') return;
  const conn = Object.values(r.players).filter(p => p.connected);
  if (conn.length === 0) return;
  if (conn.every(p => p.finished)) {
    // record DNF players
    for (const c in r.players) { const p = r.players[c]; if (p.connected && !p.recorded) { p.recorded = true; recordGame(c, { won: false, level: r.level, playTime: (Date.now() - r.startedAt) / 1000 }); } }

    // RE-RANK by solve time: fastest = 1st, DNF = last
    const all = Object.values(r.players).filter(p => p.connected);
    all.sort((a, b) => {
      // finishers before DNF
      const af = a.solveTime != null, bf = b.solveTime != null;
      if (af && !bf) return -1;
      if (!af && bf) return 1;
      if (af && bf) return a.solveTime - b.solveTime;  // lowest time = 1st
      return 0;
    });
    all.forEach((p, i) => { p.place = i + 1; });

    r.state = 'over';
    io.to(r.id).emit('roundOver', { level: r.level, players: roomList(r) });
  }
}

/* ---------------- platform plumbing ---------------- */
const sockByCid = {};
const online = () => new Set(Object.keys(sockByCid));

function recordGame(cid, result) {
  const P = store.getPlayer(cid);
  const res = platform.recordResult(P, result, Date.now(), { event: activeEvent() });
  store.save();
  notify(cid, res);
  io.emit('board:dirty');
}
function notify(cid, res) {
  const s = sockByCid[cid]; if (!s) return;
  if (res.unlocked && res.unlocked.length) s.emit('achievements', res.unlocked);
  if (res.completed && res.completed.length) s.emit('missions:done', res.completed);
  if (res.cosmetics && res.cosmetics.length) s.emit('rewards', res.cosmetics);
  s.emit('notif:count', platform.listNotifs(store.getPlayer(cid)).unread);
}
function pushNotif(cid, notif) {                 // deliver a live notification if online
  const s = sockByCid[cid]; if (!s || !notif) return;
  s.emit('notif:new', notif);
  s.emit('notif:count', platform.listNotifs(store.getPlayer(cid)).unread);
}
function pingFriends(cid) {                       // tell online friends to refresh presence/list
  const P = store.getPlayer(cid);
  for (const f of P.friends) { const s = sockByCid[f]; if (s) s.emit('friends:dirty'); }
}

/* ---------------- connections ---------------- */
io.on('connection', socket => {
  const cid = (socket.handshake.auth && socket.handshake.auth.cid) || socket.id;
  socket.data.cid = cid;
  sockByCid[cid] = socket;

  /* per-socket middleware: rate-limit every inbound event + isolate errors */
  socket.use((packet, next) => {
    const event = Array.isArray(packet) ? packet[0] : null;
    if (event && !rateLimiter.allow(cid, event)) {
      socket.emit('rate_limited', { event });
      log.warn('rate_limited', { cid, event });
      return; // drop the event (do not call next)
    }
    next();
  });
  socket.on('error', err => log.error('socket_error', { cid, err: String(err && err.message || err) }));
  const P = store.getPlayer(cid);
  socket.emit('me', { cid, hasProfile: !!P.name, name: P.name, country: P.country, avatar: P.avatar, friendCode: P.friendCode });
  socket.emit('notif:count', platform.listNotifs(P).unread);
  pingFriends(cid);

  let room = null;
  for (const id in rooms) if (rooms[id].players[cid]) { room = rooms[id]; break; }
  if (room) {
    // RECONNECT: player was already in a room — rejoin them
    const p = room.players[cid]; p.connected = true; p.socketId = socket.id;
    socket.join(room.id); socket.data.roomId = room.id;
    socket.emit('joined', { you: cid, roomId: room.id, level: room.level, state: room.state, target: room.target });
    if (room.state === 'playing') socket.emit('start', { seed: room.seed, level: room.level, players: roomList(room), target: room.target });
    if (room.state === 'over') socket.emit('roundOver', { level: room.level, players: roomList(room) });
    broadcast(room);
  } else {
    // NEW player: do NOT auto-join. Wait for them to choose 2P or 3P via 'matchmake'.
    socket.emit('choose_mode', { pick: true });
  }

  /* Player picks 2P or 3P → join the right room */
  socket.on('matchmake', d => {
    if (socket.data.roomId && rooms[socket.data.roomId]) return;  // already in a room
    const target = (d && (d.target === 2 || d.target === 3)) ? d.target : 3;
    room = openRoom(target);
    const slot = Object.keys(room.players).length;
    room.players[cid] = { cid, socketId: socket.id, name: P.name || ('Player ' + (slot + 1)), color: (P.avatar && P.avatar.color) || COLORS[slot % 3], avatar: P.avatar, progress: 0, finished: false, place: 0, connected: true, ready: false, recorded: false };
    room.order.push(cid);
    socket.join(room.id); socket.data.roomId = room.id;
    socket.emit('joined', { you: cid, roomId: room.id, level: room.level, state: room.state, target: room.target });
    broadcast(room); startLobby(room);
    log.info('matchmake', { cid, target, roomId: room.id, count: Object.keys(room.players).length });
  });

  /* Player cancels matchmaking and goes back to mode select */
  socket.on('matchmake:cancel', () => {
    const r = rooms[socket.data.roomId]; if (!r) { socket.emit('choose_mode', { pick: true }); return; }
    if (r.state !== 'lobby') return; // can't cancel if match already started
    if (r.lobbyTimer) { clearTimeout(r.lobbyTimer); r.lobbyTimer = null; }
    delete r.players[cid]; r.order = r.order.filter(x => x !== cid);
    broadcast(r);
    if (Object.keys(r.players).length === 0) {
      if (r.code && privateCodes[r.code] === r.id) delete privateCodes[r.code];
      delete rooms[r.id];
    }
    socket.leave(r.id); socket.data.roomId = null;
    socket.emit('choose_mode', { pick: true });
  });

  /* ----- multiplayer ----- */
  socket.on('progress', v => { const r = rooms[socket.data.roomId]; if (!r) return; const p = r.players[cid]; if (!p || p.finished) return; p.progress = Math.max(p.progress, Math.max(0, Math.min(100, v | 0))); broadcast(r); });
  socket.on('finish', data => {
    const r = rooms[socket.data.roomId]; if (!r || r.state !== 'playing') return;
    const p = r.players[cid]; if (!p || p.finished) return;
    // server-authoritative time: never trust the client's number outright.
    const wallClock = (Date.now() - r.startedAt) / 1000;
    const claimed = data && Number.isFinite(+data.time) ? +data.time : wallClock;
    // the reported solve time cannot be less than the time actually elapsed on the server.
    const observed = Math.max(claimed, 0.1);
    const check = integrity.validateFinish({ level: r.level, solveTime: Math.max(observed, 0) });
    if (!check.ok && check.reasons && check.reasons.includes('impossibly_fast')) {
      log.warn('cheat_rejected_finish', { cid, level: r.level, claimed, reasons: check.reasons });
      socket.emit('result_rejected', { reason: 'invalid_time' });
      return; // refuse to record a physically impossible solve
    }
    // clamp into the plausible window AND floor at server wall-clock (can't beat real elapsed time)
    const solve = Math.max(check.clampedTime || observed, Math.min(wallClock, integrity.maxSolveSeconds(r.level)));
    p.finished = true; p.progress = 100; p.place = ++r.finishCount; p.recorded = true;
    p.solveTime = solve;  // store for solve-time-based ranking
    recordGame(cid, { won: true, level: r.level, solveTime: solve, playTime: solve });
    io.to(r.id).emit('playerFinished', { id: cid, name: p.name, place: p.place, solveTime: solve });
    broadcast(r); checkRoundOver(r);
  });
  socket.on('timeout', () => { const r = rooms[socket.data.roomId]; if (!r || r.state !== 'playing') return; const p = r.players[cid]; if (!p || p.finished) return; p.finished = true; broadcast(r); checkRoundOver(r); });
  socket.on('playAgain', () => {
    const r = rooms[socket.data.roomId]; if (!r) return; const p = r.players[cid]; if (!p) return; p.ready = true;
    const conn = Object.values(r.players).filter(x => x.connected);
    const floor = r.private ? PRIV_MIN : r.target;
    if (conn.length >= floor && conn.every(x => x.ready)) { r.level++; startRound(r); } else broadcast(r);
  });

  /* ----- PRIVATE ROOMS ----- */
  /* Create a private room — leaves current public room, creates an invite-only room */
  socket.on('room:create', () => {
    // leave current room cleanly first
    const oldR = rooms[socket.data.roomId];
    if (oldR) {
      if (oldR.lobbyTimer) { clearTimeout(oldR.lobbyTimer); oldR.lobbyTimer = null; }
      delete oldR.players[cid]; oldR.order = oldR.order.filter(x => x !== cid);
      broadcast(oldR);
      if (Object.keys(oldR.players).length === 0) {
        if (oldR.code && privateCodes[oldR.code] === oldR.id) delete privateCodes[oldR.code];
        delete rooms[oldR.id];
      }
      socket.leave(oldR.id);
    }
    const pr = makePrivateRoom();
    const slot = 0;
    pr.players[cid] = { cid, socketId: socket.id, name: P.name || 'Player 1', color: (P.avatar && P.avatar.color) || COLORS[slot % 4], avatar: P.avatar, progress: 0, finished: false, place: 0, connected: true, ready: false, recorded: false };
    pr.order.push(cid);
    socket.join(pr.id); socket.data.roomId = pr.id;
    socket.emit('room:created', { code: pr.code, roomId: pr.id });
    broadcast(pr);
    io.to(pr.id).emit('lobby', { count: 1, private: true, code: pr.code });
    log.info('private_room_created', { cid, code: pr.code });
  });

  /* Join a private room by code */
  socket.on('room:join', ({ code } = {}) => {
    const clean = (code || '').toString().trim().toUpperCase();
    const roomId = privateCodes[clean];
    const pr = roomId && rooms[roomId];
    if (!pr) { socket.emit('room:error', { msg: 'Room not found. Check the code and try again.' }); return; }
    if (!pr.private) { socket.emit('room:error', { msg: 'Not a private room.' }); return; }
    if (pr.state !== 'lobby') { socket.emit('room:error', { msg: 'Match already started.' }); return; }
    if (Object.keys(pr.players).length >= PRIV_MAX) { socket.emit('room:error', { msg: 'Room is full (max 4 players).' }); return; }
    // leave current room first
    const oldR = rooms[socket.data.roomId];
    if (oldR && oldR.id !== pr.id) {
      if (oldR.lobbyTimer) { clearTimeout(oldR.lobbyTimer); oldR.lobbyTimer = null; }
      delete oldR.players[cid]; oldR.order = oldR.order.filter(x => x !== cid);
      broadcast(oldR);
      if (Object.keys(oldR.players).length === 0) {
        if (oldR.code && privateCodes[oldR.code] === oldR.id) delete privateCodes[oldR.code];
        delete rooms[oldR.id];
      }
      socket.leave(oldR.id);
    }
    const slot = Object.keys(pr.players).length;
    pr.players[cid] = { cid, socketId: socket.id, name: P.name || ('Player ' + (slot + 1)), color: (P.avatar && P.avatar.color) || COLORS[slot % 4], avatar: P.avatar, progress: 0, finished: false, place: 0, connected: true, ready: false, recorded: false };
    pr.order.push(cid);
    socket.join(pr.id); socket.data.roomId = pr.id;
    socket.emit('room:joined', { code: pr.code, roomId: pr.id });
    broadcast(pr); startLobby(pr);
    log.info('private_room_joined', { cid, code: pr.code, count: Object.keys(pr.players).length });
  });

  /* Leave private room and go back to public matchmaking */
  socket.on('room:leave', () => {
    const r = rooms[socket.data.roomId]; if (!r || !r.private) return;
    if (r.lobbyTimer) { clearTimeout(r.lobbyTimer); r.lobbyTimer = null; }
    delete r.players[cid]; r.order = r.order.filter(x => x !== cid);
    broadcast(r);
    if (Object.keys(r.players).length === 0) {
      if (r.code && privateCodes[r.code] === r.id) delete privateCodes[r.code];
      delete rooms[r.id];
    }
    socket.leave(r.id); socket.data.roomId = null;
    // send back to mode select (player chooses 2P/3P again)
    socket.emit('choose_mode', { pick: true });
  });

  /* ----- profile / identity / customization ----- */
  function emitMe() { const pl = store.getPlayer(cid); socket.emit('me', { cid, hasProfile: !!pl.name, name: pl.name, country: pl.country, avatar: pl.avatar, friendCode: pl.friendCode }); }
  socket.on('profile:set', d => {
    const pl = store.getPlayer(cid);
    if (d && d.name) pl.name = ('' + d.name).slice(0, 14);
    if (d && d.country) pl.country = ('' + d.country).slice(0, 2).toUpperCase();
    if (d && d.avatarColor) { pl.avatarColor = ('' + d.avatarColor).slice(0, 9); pl.avatar.color = pl.avatarColor; }
    store.save();
    const r = rooms[socket.data.roomId]; if (r && r.players[cid]) { r.players[cid].name = pl.name; r.players[cid].color = pl.avatar.color; r.players[cid].avatar = pl.avatar; broadcast(r); }
    emitMe(); io.emit('board:dirty');
    // if player isn't in a room yet, send them to mode select
    if (!socket.data.roomId || !rooms[socket.data.roomId]) socket.emit('choose_mode', { pick: true });
  });
  socket.on('profile:customize', d => {
    const pl = store.getPlayer(cid);
    const view = platform.customizeProfile(DB(), pl, d || {});
    store.save();
    const r = rooms[socket.data.roomId]; if (r && r.players[cid]) { r.players[cid].name = pl.name; r.players[cid].color = pl.avatar.color; r.players[cid].avatar = pl.avatar; broadcast(r); }
    emitMe(); socket.emit('profile', view); io.emit('board:dirty');
  });
  socket.on('profile:get', () => socket.emit('profile', platform.profileView(DB(), store.getPlayer(cid))));
  socket.on('cosmetics:get', () => socket.emit('cosmetics', platform.cosmeticsCatalog(store.getPlayer(cid))));

  /* ----- leaderboards ----- */
  socket.on('board:get', q => {
    const scope = (q && q.scope) || 'alltime';
    const limit = (q && q.limit) || (scope === 'top10' ? 10 : 100);
    const country = (q && q.country) || store.getPlayer(cid).country;
    const ev = activeEvent();
    socket.emit('board', platform.buildBoard(DB(), scope, { limit, country, viewerCid: cid, eventId: ev && ev.id }));
  });

  /* ----- daily maze + ghosts ----- */
  socket.on('daily:get', () => { const dk = todayKey(); socket.emit('daily:info', { dateKey: dk, seed: SC.dailySeed(dk) }); });
  socket.on('daily:submit', d => {
    if (!d || typeof d.time !== 'number') return;
    const dk = todayKey(); const res = platform.dailySubmit(DB(), store.getPlayer(cid), dk, d.time);
    store.save(); notify(cid, res); io.emit('board:dirty');
    socket.emit('daily:result', { best: res.best });
  });
  socket.on('daily:board', () => socket.emit('daily:leaderboard', platform.dailyBoard(DB(), todayKey(), 100, cid)));
  socket.on('ghost:save', d => { if (!d) return; const res = platform.saveGhost(DB(), store.getPlayer(cid), d.track, d.time, d.frames); store.save(); socket.emit('ghost:saved', res); });
  socket.on('ghost:get', d => socket.emit('ghost:data', { track: d && d.track, ghost: platform.getGhost(DB(), store.getPlayer(cid), d && d.track) }));
  socket.on('ghost:daily-leader', () => socket.emit('ghost:leader', { dateKey: todayKey(), ghost: platform.dailyLeaderGhost(DB(), todayKey()) }));

  /* ----- events ----- */
  socket.on('event:get', () => { const now = new Date(); socket.emit('event:info', { active: EV.activeEvent(now), upcoming: EV.upcomingEvent(now), serverTime: now.getTime() }); });

  /* ----- friends (request flow) ----- */
  socket.on('friends:data', () => socket.emit('friends:list', platform.friendData(DB(), store.getPlayer(cid), online())));
  socket.on('friends:board', () => socket.emit('friends:leaderboard', platform.friendsBoard(DB(), store.getPlayer(cid))));
  socket.on('friend:request', code => { const res = platform.friendRequest(DB(), store.getPlayer(cid), code); store.save(); if (res.ok && res.targetCid) pushNotif(res.targetCid, res.notif); socket.emit('friend:result', res); socket.emit('friends:list', platform.friendData(DB(), store.getPlayer(cid), online())); });
  socket.on('friend:accept', fromCid => { const res = platform.friendAccept(DB(), store.getPlayer(cid), fromCid); store.save(); if (res.ok && res.targetCid) { pushNotif(res.targetCid, res.notif); const s = sockByCid[res.targetCid]; if (s) s.emit('friends:dirty'); } socket.emit('friend:result', res); socket.emit('friends:list', platform.friendData(DB(), store.getPlayer(cid), online())); });
  socket.on('friend:reject', fromCid => { const res = platform.friendReject(DB(), store.getPlayer(cid), fromCid); store.save(); socket.emit('friend:result', res); socket.emit('friends:list', platform.friendData(DB(), store.getPlayer(cid), online())); });
  socket.on('friend:remove', fcid => { const res = platform.friendRemove(DB(), store.getPlayer(cid), fcid); store.save(); const s = sockByCid[fcid]; if (s) s.emit('friends:dirty'); socket.emit('friend:result', res); socket.emit('friends:list', platform.friendData(DB(), store.getPlayer(cid), online())); });
  socket.on('friend:profile', fcid => socket.emit('friend:profile:data', platform.publicProfile(DB(), fcid)));
  socket.on('friend:add', code => { const res = platform.addFriend(DB(), store.getPlayer(cid), code); store.save(); socket.emit('friend:added', res); }); // backward compat

  /* ----- notifications ----- */
  socket.on('notif:list', () => socket.emit('notif:data', platform.listNotifs(store.getPlayer(cid))));
  socket.on('notif:read', ids => { platform.markRead(store.getPlayer(cid), ids); store.save(); socket.emit('notif:data', platform.listNotifs(store.getPlayer(cid))); socket.emit('notif:count', platform.listNotifs(store.getPlayer(cid)).unread); });
  socket.on('notif:clear', () => { platform.clearNotifs(store.getPlayer(cid)); store.save(); socket.emit('notif:data', platform.listNotifs(store.getPlayer(cid))); socket.emit('notif:count', 0); });

  /* ----- disconnect ----- */
  socket.on('disconnect', () => {
    if (sockByCid[cid] === socket) delete sockByCid[cid];
    pingFriends(cid);
    const r = rooms[socket.data.roomId]; if (!r) return; const p = r.players[cid]; if (!p) return;
    if (r.state === 'lobby') {
      delete r.players[cid]; r.order = r.order.filter(x => x !== cid);
      if (Object.keys(r.players).length < (r.private ? PRIV_MIN : r.target) && r.lobbyTimer) { clearTimeout(r.lobbyTimer); r.lobbyTimer = null; }
      broadcast(r);
      if (Object.keys(r.players).length === 0) {
        if (r.code && privateCodes[r.code] === r.id) delete privateCodes[r.code];
        delete rooms[r.id];
      }
    } else {
      p.connected = false; broadcast(r); checkRoundOver(r);
      setTimeout(() => {
        const rr = rooms[r.id];
        if (rr && Object.values(rr.players).every(x => !x.connected)) {
          if (rr.code && privateCodes[rr.code] === rr.id) delete privateCodes[rr.code];
          delete rooms[r.id];
        }
      }, GRACE);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log.info('server_started', { port: +PORT, version: require('./package.json').version }));

/* ---------------- graceful shutdown + crash isolation ---------------- */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  log.info('shutdown_begin', { signal });
  try { store.flush ? store.flush() : store.save(); } catch (e) { log.error('flush_failed', { err: String(e) }); }
  io.close(() => log.info('io_closed'));
  server.close(() => { log.info('shutdown_complete'); process.exit(0); });
  // hard cap so we never hang a deploy
  setTimeout(() => { log.warn('shutdown_forced'); process.exit(0); }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

/* never let a single bad event take the whole process down */
process.on('uncaughtException',  err => { log.error('uncaught_exception',  { err: String(err && err.stack || err) }); });
process.on('unhandledRejection', err => { log.error('unhandled_rejection', { err: String(err && err.stack || err) }); });

module.exports = { app, server, io };
