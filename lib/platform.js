/* ============================================================
   SPIRAL RUSH — competitive platform logic (production)
   ------------------------------------------------------------
   Results → stats, scores, ranks, leaderboards, achievements,
   missions, seasons, daily maze, friends (request flow),
   server-side ghosts, events, notifications, rewards,
   profile customization. Pure-ish (operates on store db).
   ============================================================ */
'use strict';
const SC = require('./scoring');
const COS = require('./cosmetics');
const EV = require('./events');

/* ---------- notifications ---------- */
let notifSeq = 1;
function addNotif(P, n) {
  const notif = { id: 'n' + (notifSeq++) + '_' + Date.now().toString(36), ts: Date.now(), read: false, type: n.type, text: n.text, data: n.data || null };
  P.notifications.unshift(notif);
  if (P.notifications.length > 60) P.notifications.length = 60;
  return notif;
}
function listNotifs(P) { return { items: P.notifications, unread: P.notifications.filter(x => !x.read).length }; }
function markRead(P, ids) { const set = new Set(ids || []); P.notifications.forEach(n => { if (!ids || set.has(n.id)) n.read = true; }); return listNotifs(P); }
function clearNotifs(P) { P.notifications = []; return listNotifs(P); }

/* ---------- leaderboard row (incl. avatar for rendering) ---------- */
function rowOf(P, score) {
  const S = P.stats, tier = SC.tierFor(P.scoreCache);
  return {
    cid: P.cid, name: P.name || 'Anon', country: P.country || 'XX',
    avatar: P.avatar, tierColor: tier.color,
    highestLevel: S.highestLevel, avgSolve: SC.avgSolve(S), wins: S.wins,
    winRate: SC.winRate(S), score, tier: tier.name
  };
}

/* ---------- record a finished game ---------- */
function recordResult(P, r, now, ctx) {
  const S = P.stats, d = new Date(now);
  const keys = SC.periodKeys(d), sid = SC.seasonId(d);
  const event = ctx && ctx.event ? ctx.event : null;

  S.gamesPlayed++; S.totalPlayTime += Math.max(0, r.playTime || 0);
  if ((r.level || 0) > S.highestLevel) S.highestLevel = r.level;

  let pts = 10;
  const events = [{ type: 'game' }, { type: 'level', level: r.level || 0 }];
  if (r.won) {
    S.wins++; S.solveCount++; S.totalSolveTime += Math.max(0, r.solveTime || 0);
    S.fastestSolve = S.fastestSolve == null ? r.solveTime : Math.min(S.fastestSolve, r.solveTime);
    S.currentStreak++; S.longestStreak = Math.max(S.longestStreak, S.currentStreak);
    pts += 100 + Math.round(SC.clamp(200 - (r.solveTime || 999), 0, 200));
    events.push({ type: 'win' });
  } else { S.currentStreak = 0; }

  /* limited-time event bonus */
  let eventBonus = 0;
  if (event) {
    eventBonus = EV.eventBonus(event, pts, r);
    pts += eventBonus;
    P.eventPoints[event.id] = (P.eventPoints[event.id] || 0) + pts;
    if (!P.eventBadges[event.id]) { P.eventBadges[event.id] = Date.now(); addNotif(P, { type: 'event', text: 'Joined event: ' + event.name }); }
  }

  P.scoreCache = SC.globalScore(S);

  for (const scope of ['day', 'week', 'month']) {
    const key = keys[scope];
    let per = P.periods[scope];
    if (!per || per.key !== key) per = P.periods[scope] = { key, points: 0, games: 0, wins: 0, bestLevel: 0, sumTime: 0, solveCount: 0, bestTime: null };
    per.points += pts; per.games++;
    if (r.won) { per.wins++; per.solveCount++; per.sumTime += (r.solveTime || 0); per.bestTime = per.bestTime == null ? r.solveTime : Math.min(per.bestTime, r.solveTime); }
    per.bestLevel = Math.max(per.bestLevel, r.level || 0);
  }
  if (P.season.id !== sid) P.season = { id: sid, score: 0 };
  P.season.score += pts;

  const completed = [];
  for (const e of events) completed.push(...SC.updateMissions(P, keys.day, e));
  for (const c of completed) { P.season.score += c.reward; if (P.periods.day) P.periods.day.points += c.reward; addNotif(P, { type: 'mission', text: 'Mission complete: ' + c.name + ' (+' + c.reward + ')' }); }

  const unlocked = SC.evaluateAchievements(P);
  for (const a of unlocked) addNotif(P, { type: 'achievement', text: 'Achievement: ' + a.name, data: { id: a.id } });

  const cosmetics = COS.grantNewUnlocks(P);
  for (const c of cosmetics) addNotif(P, { type: 'reward', text: 'Unlocked ' + c.kind.replace(/s$/, '') + ': ' + c.name, data: c });

  return { unlocked, completed, cosmetics, eventBonus, score: P.scoreCache };
}

/* ---------- leaderboards ---------- */
function buildBoard(db, scope, opts = {}) {
  const limit = opts.limit || 100;
  const now = new Date(), keys = SC.periodKeys(now), sid = SC.seasonId(now);
  const rows = [];
  for (const cid in db.players) {
    const P = db.players[cid]; if (!P.name) continue;
    if (scope === 'alltime' || scope === 'top10' || scope === 'top100') rows.push(rowOf(P, P.scoreCache));
    else if (scope === 'country') { if (P.country === opts.country) rows.push(rowOf(P, P.scoreCache)); }
    else if (scope === 'season') { if (P.season && P.season.id === sid) rows.push(rowOf(P, P.season.score)); }
    else if (scope === 'event') { const ep = opts.eventId && P.eventPoints[opts.eventId]; if (ep) rows.push(rowOf(P, ep)); }
    else if (scope === 'daily' || scope === 'weekly' || scope === 'monthly') {
      const sc = scope === 'daily' ? 'day' : scope === 'weekly' ? 'week' : 'month';
      const per = P.periods[sc];
      if (per && per.key === keys[sc] && per.points > 0) rows.push(rowOf(P, per.points));
    }
  }
  rows.sort((a, b) => b.score - a.score || a.avgSolve - b.avgSolve);
  rows.forEach((r, i) => r.rank = i + 1);
  const me = opts.viewerCid ? (rows.find(r => r.cid === opts.viewerCid) || null) : null;
  const n = scope === 'top10' ? 10 : limit;
  return { scope, total: rows.length, rows: rows.slice(0, n), me };
}

/* ---------- daily maze ---------- */
function dailySubmit(db, P, dateKey, time) {
  const board = db.dailyMaze[dateKey] || (db.dailyMaze[dateKey] = {});
  const prev = board[P.cid];
  if (!prev || time < prev.time) board[P.cid] = { name: P.name || 'Anon', country: P.country || 'XX', time };
  if (!P.dailyDone[dateKey]) { P.dailyDone[dateKey] = true; P.stats.dailySolves = (P.stats.dailySolves || 0) + 1; }
  const completed = SC.updateMissions(P, dateKey, { type: 'daily' });
  for (const c of completed) { P.season.score += c.reward; if (P.periods.day) P.periods.day.points += c.reward; addNotif(P, { type: 'mission', text: 'Mission complete: ' + c.name + ' (+' + c.reward + ')' }); }
  P.scoreCache = SC.globalScore(P.stats);
  const unlocked = SC.evaluateAchievements(P);
  for (const a of unlocked) addNotif(P, { type: 'achievement', text: 'Achievement: ' + a.name, data: { id: a.id } });
  const cosmetics = COS.grantNewUnlocks(P);
  for (const c of cosmetics) addNotif(P, { type: 'reward', text: 'Unlocked ' + c.kind.replace(/s$/, '') + ': ' + c.name, data: c });
  return { unlocked, completed, cosmetics, best: board[P.cid].time };
}
function dailyBoard(db, dateKey, limit, viewerCid) {
  const board = db.dailyMaze[dateKey] || {};
  const rows = Object.keys(board).map(cid => ({ cid, name: board[cid].name, country: board[cid].country, time: board[cid].time }));
  rows.sort((a, b) => a.time - b.time);
  rows.forEach((r, i) => r.rank = i + 1);
  const me = viewerCid ? (rows.find(r => r.cid === viewerCid) || null) : null;
  return { dateKey, total: rows.length, rows: rows.slice(0, limit || 100), me };
}

/* ---------- server-side GHOSTS (cross-device + multiplayer ghost races) ---------- */
function packFrames(frames) {
  if (!Array.isArray(frames)) return [];
  let f = frames.filter(x => x && typeof x.t === 'number');
  if (f.length > 400) { const step = f.length / 400; const out = []; for (let i = 0; i < 400; i++) out.push(f[Math.floor(i * step)]); out.push(f[f.length - 1]); f = out; }
  return f.map(x => ({ t: Math.round(x.t), ang: +(+x.ang).toFixed(4), rad: +(+x.rad).toFixed(4) }));
}
function saveGhost(db, P, track, time, frames) {
  if (!track || typeof time !== 'number') return { ok: false };
  const packed = packFrames(frames);
  const prev = P.ghosts[track];
  let improved = false;
  if (!prev || time < prev.time) { P.ghosts[track] = { time, frames: packed, ts: Date.now() }; improved = true; }
  // world-best ghost for daily tracks
  let world = false;
  const m = /^daily:(.+)$/.exec(track);
  if (m) {
    const dk = m[1]; const cur = db.dailyGhosts[dk];
    if (!cur || time < cur.time) { db.dailyGhosts[dk] = { cid: P.cid, name: P.name || 'Anon', country: P.country || 'XX', time, frames: packed }; world = true; }
  }
  return { ok: true, improved, world, best: P.ghosts[track].time };
}
function getGhost(db, P, track) { return P.ghosts[track] || null; }
function dailyLeaderGhost(db, dateKey) { const g = db.dailyGhosts[dateKey]; return g ? { name: g.name, country: g.country, time: g.time, frames: g.frames } : null; }

/* ---------- profile ---------- */
function profileView(db, P) {
  const S = P.stats, tier = SC.tierFor(P.scoreCache);
  const all = Object.values(db.players).filter(x => x.name).sort((a, b) => b.scoreCache - a.scoreCache);
  const globalRank = all.findIndex(x => x.cid === P.cid) + 1;
  const countryRank = all.filter(x => x.country === P.country).findIndex(x => x.cid === P.cid) + 1;
  const ach = SC.ACHIEVEMENTS.map(a => ({ id: a.id, name: a.name, desc: a.desc, unlocked: !!P.achievements[a.id] }));
  SC.ensureMissions(P, SC.periodKeys(new Date()).day);
  const missions = SC.dailyMissionDefs().map(m => ({ id: m.id, name: m.name, target: m.target, reward: m.reward, ...P.missions[m.id] }));
  return {
    cid: P.cid, name: P.name, country: P.country, avatar: P.avatar, bio: P.bio, friendCode: P.friendCode,
    tier: tier.name, tierColor: tier.color, tierIdx: tier.idx, score: P.scoreCache, nextTier: tier.next,
    title: COS.titleText(P), activeTitle: P.activeTitle,
    stats: {
      gamesPlayed: S.gamesPlayed, wins: S.wins, winRate: SC.winRate(S), highestLevel: S.highestLevel,
      avgSolve: SC.avgSolve(S), fastestSolve: S.fastestSolve, currentStreak: S.currentStreak,
      longestStreak: S.longestStreak, totalPlayTime: S.totalPlayTime, dailySolves: S.dailySolves || 0
    },
    globalRank: globalRank || all.length + 1, countryRank: countryRank || 1,
    achievements: ach, missions,
    eventBadges: Object.keys(P.eventBadges).length,
    season: { id: P.season.id, label: P.season.id != null ? SC.seasonLabel(P.season.id) : '', score: P.season.score }
  };
}
function publicProfile(db, cid) { const P = db.players[cid]; return P && P.name ? profileView(db, P) : null; }

/* cosmetics catalog with locked/unlocked state (for the customization picker) */
function cosmeticsCatalog(P) {
  const sets = COS.unlockedSets(P);
  return {
    avatar: P.avatar, activeTitle: P.activeTitle,
    symbols: COS.SYMBOLS.map(s => ({ id: s.id, name: s.name, unlocked: sets.symbols.includes(s.id) })),
    borders: COS.BORDERS.map(b => ({ id: b.id, name: b.name, unlocked: sets.borders.includes(b.id) })),
    titles:  COS.TITLES.map(t => ({ id: t.id, name: t.name, unlocked: sets.titles.includes(t.id) }))
  };
}
function customizeProfile(db, P, payload) {
  if (payload.name) P.name = ('' + payload.name).slice(0, 14);
  if (payload.country) P.country = ('' + payload.country).slice(0, 2).toUpperCase();
  if (payload.bio !== undefined) P.bio = ('' + payload.bio).slice(0, 80);
  if (payload.avatar) { P.avatar = COS.sanitizeAvatar(P, payload.avatar); P.avatarColor = P.avatar.color; }
  if (payload.title !== undefined) P.activeTitle = COS.sanitizeTitle(P, payload.title);
  return profileView(db, P);
}

/* ---------- FRIENDS (request flow) ---------- */
function friendBrief(db, cid, onlineSet) {
  const P = db.players[cid]; if (!P) return null;
  const tier = SC.tierFor(P.scoreCache);
  return { cid, name: P.name || 'Anon', country: P.country, avatar: P.avatar, tier: tier.name, tierColor: tier.color, score: P.scoreCache, online: !!(onlineSet && onlineSet.has(cid)) };
}
function friendRequest(db, P, code) {
  const cid = db.friendCodes[(code || '').trim().toUpperCase()];
  if (!cid) return { ok: false, msg: 'Code not found' };
  if (cid === P.cid) return { ok: false, msg: "That's your own code" };
  const T = db.players[cid]; if (!T || !T.name) return { ok: false, msg: 'Player not found' };
  if (P.friends.includes(cid)) return { ok: false, msg: 'Already friends' };
  if (T.incoming.includes(P.cid) || P.outgoing.includes(cid)) return { ok: false, msg: 'Request already sent' };
  if (P.incoming.includes(cid)) { return friendAccept(db, P, cid); } // they already asked → accept
  P.outgoing.push(cid); T.incoming.push(P.cid);
  const notif = addNotif(T, { type: 'friend_req', text: (P.name || 'Someone') + ' sent you a friend request', data: { cid: P.cid } });
  return { ok: true, msg: 'Request sent to ' + (T.name || 'player'), targetCid: cid, notif };
}
function friendAccept(db, P, fromCid) {
  const T = db.players[fromCid]; if (!T) return { ok: false, msg: 'Player not found' };
  P.incoming = P.incoming.filter(x => x !== fromCid);
  T.outgoing = T.outgoing.filter(x => x !== P.cid);
  if (!P.friends.includes(fromCid)) P.friends.push(fromCid);
  if (!T.friends.includes(P.cid)) T.friends.push(P.cid);
  const notif = addNotif(T, { type: 'friend_acc', text: (P.name || 'Someone') + ' accepted your friend request', data: { cid: P.cid } });
  return { ok: true, msg: 'You are now friends with ' + (T.name || 'player'), targetCid: fromCid, notif };
}
function friendReject(db, P, fromCid) {
  const T = db.players[fromCid];
  P.incoming = P.incoming.filter(x => x !== fromCid);
  if (T) T.outgoing = T.outgoing.filter(x => x !== P.cid);
  return { ok: true, msg: 'Request dismissed' };
}
function friendRemove(db, P, cid) {
  const T = db.players[cid];
  P.friends = P.friends.filter(x => x !== cid);
  if (T) T.friends = T.friends.filter(x => x !== P.cid);
  return { ok: true, msg: 'Removed' };
}
function friendData(db, P, onlineSet) {
  return {
    friendCode: P.friendCode,
    friends: P.friends.map(c => friendBrief(db, c, onlineSet)).filter(Boolean).sort((a, b) => b.score - a.score),
    incoming: P.incoming.map(c => friendBrief(db, c, onlineSet)).filter(Boolean),
    outgoing: P.outgoing.map(c => friendBrief(db, c, onlineSet)).filter(Boolean)
  };
}
function friendsBoard(db, P) {
  const ids = [P.cid, ...P.friends];
  const rows = ids.map(id => db.players[id]).filter(x => x && x.name).map(x => rowOf(x, x.scoreCache));
  rows.sort((a, b) => b.score - a.score); rows.forEach((r, i) => r.rank = i + 1);
  return { rows, me: rows.find(r => r.cid === P.cid) || null };
}

/* backward-compatible instant add (kept; old clients) */
function addFriend(db, P, code) {
  const cid = db.friendCodes[(code || '').trim().toUpperCase()];
  if (!cid || cid === P.cid) return { ok: false, msg: 'Invalid code' };
  if (!P.friends.includes(cid)) P.friends.push(cid);
  const other = db.players[cid]; if (other && !other.friends.includes(P.cid)) other.friends.push(P.cid);
  return { ok: true, friend: (other && other.name) || 'Friend' };
}

module.exports = {
  recordResult, buildBoard, dailySubmit, dailyBoard, profileView, publicProfile,
  cosmeticsCatalog, customizeProfile,
  saveGhost, getGhost, dailyLeaderGhost,
  addNotif, listNotifs, markRead, clearNotifs,
  friendRequest, friendAccept, friendReject, friendRemove, friendData, friendsBoard, friendBrief,
  addFriend
};
