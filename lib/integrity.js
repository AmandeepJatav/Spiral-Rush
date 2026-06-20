/* ============================================================
   SPIRAL RUSH — integrity & anti-cheat (server-authoritative)
   File: lib/integrity.js
   ------------------------------------------------------------
   Pure validation. The server NEVER trusts client-reported
   results blindly — it sanity-checks them against what is
   physically possible for the maze/level. Rejected results are
   clamped or refused so the leaderboard stays fair.
   ============================================================ */
'use strict';

/* maze size grows with level (mirror of the client levelConfig) */
function levelDims(level) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  return {
    rings:   clamp(8 + Math.floor((level - 1) * 0.4), 8, 20),
    sectors: clamp(13 + Math.floor((level - 1) * 0.55), 13, 30),
    time:    90 + clamp(8 + Math.floor((level - 1) * 0.4), 8, 20) * 8 + Math.floor(level / 3) * 6,
  };
}

/* a *physically minimum* solve time: you must cross at least `rings`
   cells, each move animates for MOVE_MS. This is a hard floor — any
   reported solve faster than this is impossible → reject. */
const MOVE_MS = 130;
function minSolveSeconds(level) {
  const d = levelDims(level);
  // a real solve must cross many cells; a safe UNDER-estimate is
  // rings + half the sectors worth of moves. Scales with maze size,
  // never below 1.0s. Anything faster is physically impossible → reject.
  const moves = d.rings + Math.floor(d.sectors / 2);
  return Math.max(1.0, (moves * MOVE_MS) / 1000);
}
function maxSolveSeconds(level) { return levelDims(level).time; }

/* ---- validate a reported finish for a Prize-free competitive match ---- */
function validateFinish({ level, solveTime }) {
  const reasons = [];
  if (!Number.isFinite(level) || level < 1 || level > 200) reasons.push('bad_level');
  if (!Number.isFinite(solveTime) || solveTime <= 0) reasons.push('bad_time');
  if (reasons.length) return { ok: false, reasons };

  const lo = minSolveSeconds(level), hi = maxSolveSeconds(level);
  if (solveTime < lo) reasons.push('impossibly_fast');     // forged / bot
  if (solveTime > hi + 2) reasons.push('exceeds_round_time');

  // clamp into the legal window so a borderline value still records sanely
  const clamped = Math.min(Math.max(solveTime, lo), hi);
  return { ok: reasons.length === 0, reasons, clampedTime: clamped };
}

/* ---- validate a progress update (0..100, monotonic enforced by caller) ---- */
function validateProgress(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v | 0));
}

/* ---- generic payload shape guard for socket events ---- */
function isPlainObject(o) { return o && typeof o === 'object' && !Array.isArray(o); }
function str(v, max = 64) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function num(v) { return Number.isFinite(v) ? v : 0; }

/* ---- per-player behavioural heuristics (bot / collusion signals) ---- */
function analyzePlayer(stats) {
  const flags = [];
  const winRate = stats.gamesPlayed ? stats.wins / stats.gamesPlayed : 0;
  if (stats.gamesPlayed >= 15 && winRate >= 0.98) flags.push('abnormal_win_rate');
  if (stats.longestStreak >= 20) flags.push('long_win_streak');
  if (stats.fastestSolve != null && stats.fastestSolve < 1.5) flags.push('impossible_fastest_solve');
  return { flags, winRate };
}

module.exports = {
  levelDims, minSolveSeconds, maxSolveSeconds,
  validateFinish, validateProgress, analyzePlayer,
  isPlainObject, str, num,
};
