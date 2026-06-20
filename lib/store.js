/* ============================================================
   SPIRAL RUSH — persistent store (file-based JSON)
   ------------------------------------------------------------
   No external DB needed. Survives restarts. Debounced writes.
   migrate() keeps OLD save files fully backward-compatible.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'players.json');

let db = { players: {}, dailyMaze: {}, friendCodes: {}, dailyGhosts: {} };
let saveTimer = null;

function blankStats() {
  return {
    gamesPlayed: 0, wins: 0, highestLevel: 0,
    totalSolveTime: 0, solveCount: 0, fastestSolve: null,
    currentStreak: 0, longestStreak: 0, totalPlayTime: 0, dailySolves: 0
  };
}

/* fill in any missing fields on an existing/loaded player (backward compat) */
function migrate(p) {
  if (!p.stats) p.stats = blankStats();
  for (const k in blankStats()) if (p.stats[k] === undefined) p.stats[k] = blankStats()[k];
  if (p.country === undefined) p.country = 'XX';
  if (!p.avatarColor) p.avatarColor = '#4a86e8';
  if (!p.avatar) p.avatar = { symbol: 'orb', color: p.avatarColor, border: 'none' };
  if (p.avatar.symbol === undefined) p.avatar.symbol = 'orb';
  if (p.avatar.color === undefined) p.avatar.color = p.avatarColor || '#4a86e8';
  if (p.avatar.border === undefined) p.avatar.border = 'none';
  if (p.bio === undefined) p.bio = '';
  if (p.activeTitle === undefined) p.activeTitle = 'auto';
  if (typeof p.scoreCache !== 'number') p.scoreCache = 0;
  if (!p.achievements) p.achievements = {};
  if (p.missionsDate === undefined) p.missionsDate = null;
  if (!p.missions) p.missions = {};
  if (!p.periods) p.periods = { day: null, week: null, month: null };
  if (!p.season) p.season = { id: null, score: 0 };
  if (!p.unlocks) p.unlocks = { symbols: {}, borders: {}, titles: {} };
  if (!p.unlocks.symbols) p.unlocks.symbols = {};
  if (!p.unlocks.borders) p.unlocks.borders = {};
  if (!p.unlocks.titles) p.unlocks.titles = {};
  if (!Array.isArray(p.friends)) p.friends = [];
  if (!Array.isArray(p.incoming)) p.incoming = [];
  if (!Array.isArray(p.outgoing)) p.outgoing = [];
  if (!Array.isArray(p.notifications)) p.notifications = [];
  if (!p.eventPoints) p.eventPoints = {};
  if (!p.eventBadges) p.eventBadges = {};
  if (!p.ghosts) p.ghosts = {};
  if (!p.dailyDone) p.dailyDone = {};
  if (!p.createdAt) p.createdAt = Date.now();
  return p;
}

function load() {
  try {
    if (fs.existsSync(FILE)) {
      db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      db.players = db.players || {};
      db.dailyMaze = db.dailyMaze || {};
      db.friendCodes = db.friendCodes || {};
      db.dailyGhosts = db.dailyGhosts || {};
      for (const cid in db.players) migrate(db.players[cid]);   // upgrade old records
    }
  } catch (e) { console.error('store load failed, starting fresh:', e.message); }
  return db;
}

function save() {                       // debounced + atomic-ish (tmp then rename)
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error('store save failed:', e.message); }
  }, 400);
}

function flush() {                       // synchronous immediate write (graceful shutdown)
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
    return true;
  } catch (e) { console.error('store flush failed:', e.message); return false; }
}

function makeFriendCode(cid) {
  let code;
  do { code = 'SR-' + Math.random().toString(36).slice(2, 7).toUpperCase(); }
  while (db.friendCodes[code]);
  db.friendCodes[code] = cid;
  return code;
}

function getPlayer(cid) {
  let p = db.players[cid];
  if (!p) {
    p = db.players[cid] = migrate({
      cid, name: '', country: 'XX', avatarColor: '#4a86e8',
      createdAt: Date.now(), stats: blankStats(), scoreCache: 0,
      achievements: {}, missionsDate: null, missions: {},
      periods: { day: null, week: null, month: null },
      season: { id: null, score: 0 }, friendCode: '', friends: []
    });
    p.friendCode = makeFriendCode(cid);
  } else { migrate(p); }
  return p;
}

module.exports = { load, save, flush, getPlayer, blankStats, migrate, db: () => db };
