/* ============================================================
   SPIRAL RUSH — scoring, ranking, achievements, seasons (pure)
   ------------------------------------------------------------
   No I/O here. Everything is deterministic & unit-testable.
   ============================================================ */
'use strict';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- derived stat helpers ---------- */
function winRate(s)  { return s.gamesPlayed > 0 ? s.wins / s.gamesPlayed : 0; }
function avgSolve(s) { return s.solveCount > 0 ? s.totalSolveTime / s.solveCount : 0; } // seconds

/* ---------- GLOBAL SCORE ----------
   Rewards: depth (level), victories, consistency (win rate) and SPEED.
   Not level-only — a fast, consistent player outranks a slow grinder. */
function globalScore(s) {
  const level     = (s.highestLevel || 0) * 100;
  const victories = (s.wins || 0) * 25;
  const consist   = winRate(s) * 500;
  const avg       = avgSolve(s);
  const speed     = s.solveCount > 0 ? clamp(200 - avg, 0, 200) * 3 : 0;
  return Math.round(level + victories + consist + speed);
}

/* ---------- PRO RANK TIERS (auto from score) ---------- */
const TIERS = [
  { name: 'Bronze',         min: 0,     color: '#cd7f32' },
  { name: 'Silver',         min: 800,   color: '#c0c7d0' },
  { name: 'Gold',           min: 1800,  color: '#f6c12b' },
  { name: 'Platinum',       min: 3200,  color: '#5fd0c4' },
  { name: 'Diamond',        min: 5000,  color: '#5ac8fa' },
  { name: 'Master',         min: 7500,  color: '#a06bff' },
  { name: 'Grandmaster',    min: 10500, color: '#ff6fae' },
  { name: 'Legend',         min: 14000, color: '#ff8c42' },
  { name: 'Mythic',         min: 18000, color: '#ff4d6d' },
  { name: 'World Champion',  min: 23000, color: '#ffd23f' }
];
function tierFor(score) {
  let t = TIERS[0];
  for (const x of TIERS) if (score >= x.min) t = x;
  const idx = TIERS.indexOf(t);
  const next = TIERS[idx + 1] || null;
  return { name: t.name, idx, color: t.color, min: t.min, next: next ? next.min : null };
}

/* ---------- TITLES (flavour, from performance) ---------- */
function titleFor(p) {
  const s = p.stats;
  if ((p.scoreCache || 0) >= 23000) return 'World Champion';
  if (avgSolve(s) > 0 && avgSolve(s) < 20 && s.wins >= 10) return 'Speed Demon';
  if (s.longestStreak >= 10) return 'Unstoppable';
  if (s.highestLevel >= 30) return 'Maze Master';
  if (s.wins >= 25) return 'Veteran';
  if (s.wins >= 1) return 'Challenger';
  return 'Rookie';
}

/* ---------- ACHIEVEMENTS / BADGES ---------- */
const ACHIEVEMENTS = [
  { id: 'first_win',  name: 'First Blood',   desc: 'Win your first race',        test: s => s.wins >= 1 },
  { id: 'win_5',      name: 'On a Roll',      desc: 'Win 5 races',                test: s => s.wins >= 5 },
  { id: 'win_25',     name: 'Dominator',      desc: 'Win 25 races',               test: s => s.wins >= 25 },
  { id: 'level_10',   name: 'Deep Diver',     desc: 'Reach level 10',             test: s => s.highestLevel >= 10 },
  { id: 'level_20',   name: 'Spiral Sage',    desc: 'Reach level 20',             test: s => s.highestLevel >= 20 },
  { id: 'level_30',   name: 'Labyrinth Lord', desc: 'Reach level 30',             test: s => s.highestLevel >= 30 },
  { id: 'streak_3',   name: 'Hat-Trick',      desc: '3-win streak',               test: s => s.longestStreak >= 3 },
  { id: 'streak_10',  name: 'Juggernaut',     desc: '10-win streak',              test: s => s.longestStreak >= 10 },
  { id: 'speed_30',   name: 'Quicksilver',    desc: 'Solve in under 30s',         test: s => s.fastestSolve != null && s.fastestSolve < 30 },
  { id: 'games_50',   name: 'Marathoner',     desc: 'Play 50 games',              test: s => s.gamesPlayed >= 50 },
  { id: 'daily_done', name: 'Daily Grinder',  desc: 'Solve a Daily Maze',         test: s => (s.dailySolves || 0) >= 1 },
  { id: 'daily_7',    name: 'Streak Keeper',  desc: 'Solve 7 Daily Mazes',        test: s => (s.dailySolves || 0) >= 7 }
];
function evaluateAchievements(player) {
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (!player.achievements[a.id] && a.test(player.stats)) {
      player.achievements[a.id] = Date.now();
      unlocked.push({ id: a.id, name: a.name, desc: a.desc });
    }
  }
  return unlocked;
}

/* ---------- DAILY MISSIONS (reset each day) ---------- */
function dailyMissionDefs() {
  return [
    { id: 'm_play3', name: 'Play 3 games',        target: 3, reward: 150 },
    { id: 'm_win2',  name: 'Win 2 races',         target: 2, reward: 250 },
    { id: 'm_lvl',   name: 'Reach level 8',       target: 8, reward: 200, kind: 'level' },
    { id: 'm_daily', name: 'Finish the Daily Maze', target: 1, reward: 300, kind: 'daily' }
  ];
}
function ensureMissions(player, dateKey) {
  if (player.missionsDate !== dateKey) {
    player.missionsDate = dateKey;
    player.missions = {};
    for (const m of dailyMissionDefs()) player.missions[m.id] = { progress: 0, done: false };
  }
}
/* event: {type:'game'|'win'|'level'|'daily', level} */
function updateMissions(player, dateKey, event) {
  ensureMissions(player, dateKey);
  const completed = [];
  for (const m of dailyMissionDefs()) {
    const st = player.missions[m.id]; if (st.done) continue;
    if (m.id === 'm_play3' && event.type === 'game') st.progress++;
    if (m.id === 'm_win2'  && event.type === 'win')  st.progress++;
    if (m.id === 'm_lvl'   && event.type === 'level') st.progress = Math.max(st.progress, event.level || 0);
    if (m.id === 'm_daily' && event.type === 'daily') st.progress = 1;
    if (st.progress >= m.target) { st.done = true; completed.push({ id: m.id, name: m.name, reward: m.reward }); }
  }
  return completed;
}

/* ---------- TIME PERIOD + SEASON KEYS ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(d)   { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function monthKey(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1); }
function weekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;                 // Mon=0
  t.setUTCDate(t.getUTCDate() - day + 3);              // Thursday of this week
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return t.getUTCFullYear() + '-W' + pad(week);
}
function periodKeys(d) { return { day: dayKey(d), week: weekKey(d), month: monthKey(d) }; }

/* Season = ~3-month block since epoch */
function seasonId(d) {
  const months = d.getUTCFullYear() * 12 + d.getUTCMonth();
  return Math.floor(months / 3);
}
function seasonLabel(id) {
  const startMonth = id * 3;
  const y = Math.floor(startMonth / 12), m = startMonth % 12;
  const q = Math.floor(m / 3) + 1;
  return `${y} · Season ${q}`;
}

/* ---------- DAILY IMPOSSIBLE MAZE SEED (same worldwide) ---------- */
function dailySeed(dateKeyStr) {
  let h = 2166136261 >>> 0;                            // FNV-1a hash of the date string
  for (let i = 0; i < dateKeyStr.length; i++) { h ^= dateKeyStr.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

module.exports = {
  clamp, winRate, avgSolve, globalScore, TIERS, tierFor, titleFor,
  ACHIEVEMENTS, evaluateAchievements,
  dailyMissionDefs, ensureMissions, updateMissions,
  periodKeys, dayKey, weekKey, monthKey, seasonId, seasonLabel, dailySeed
};
