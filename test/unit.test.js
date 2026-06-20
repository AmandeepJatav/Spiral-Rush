/* ============================================================
   SPIRAL RUSH — unit tests (pure logic, no server)
   File: test/unit.test.js
   ============================================================ */
'use strict';
const SC  = require('../lib/scoring');
const COS = require('../lib/cosmetics');
const EV  = require('../lib/events');
const INT = require('../lib/integrity');
const { RateLimiter } = require('../lib/ratelimit');

function runUnit() {
  let pass = 0, fail = 0; const fails = [];
  const A = (c, m) => { if (c) { pass++; } else { fail++; fails.push(m); console.log('  ✗ ' + m); } };

  /* ---- scoring & ranking ---- */
  const slow = { gamesPlayed: 20, wins: 10, highestLevel: 12, totalSolveTime: 20 * 120, solveCount: 10, fastestSolve: 90, longestStreak: 3 };
  const fast = { gamesPlayed: 20, wins: 18, highestLevel: 12, totalSolveTime: 10 * 18, solveCount: 18, fastestSolve: 9, longestStreak: 8 };
  A(SC.globalScore(fast) > SC.globalScore(slow), 'fast player outranks slow grinder');
  A(SC.tierFor(0).name === 'Bronze' && SC.tierFor(25000).name === 'World Champion', 'tier thresholds');
  A(SC.TIERS.length === 10, '10 pro tiers');
  A(SC.dailySeed('2026-06-11') === SC.dailySeed('2026-06-11') && SC.dailySeed('2026-06-11') !== SC.dailySeed('2026-06-12'), 'daily seed deterministic + date-varying');

  /* ---- cosmetics unlock + guard ---- */
  const p = { scoreCache: 0, achievements: {}, eventBadges: {}, avatar: COS.defaultAvatar(), activeTitle: 'auto', unlocks: { symbols: {}, borders: {}, titles: {} } };
  const sets0 = COS.unlockedSets(p);
  A(sets0.symbols.includes('orb') && !sets0.symbols.includes('star'), 'default unlocked, locked stay locked');
  const av = COS.sanitizeAvatar(p, { symbol: 'star', color: '#ff0000', border: 'champion' });
  A(av.symbol === 'orb' && av.border === 'none' && av.color === '#ff0000', 'sanitizeAvatar rejects locked, keeps valid color');

  /* ---- events ---- */
  A(EV.activeEvent(new Date(Date.UTC(2026, 5, 11))) === null, 'no event on a weekday');
  A(EV.activeEvent(new Date(Date.UTC(2026, 5, 13, 12))) !== null, 'event active on weekend');
  A(EV.eventBonus({ kind: 'mult', value: 2 }, 100, { won: true }) === 100, 'double-score bonus');

  /* ---- integrity / anti-cheat ---- */
  A(INT.validateFinish({ level: 1, solveTime: 0.4 }).reasons.includes('impossibly_fast'), 'rejects impossibly fast solve');
  A(INT.validateFinish({ level: 1, solveTime: 30 }).ok, 'accepts plausible solve');
  A(INT.validateProgress(150) === 100 && INT.validateProgress(-5) === 0, 'progress clamps 0..100');
  A(INT.minSolveSeconds(30) > INT.minSolveSeconds(1), 'harder level needs more time');
  const fl = INT.analyzePlayer({ gamesPlayed: 50, wins: 50, longestStreak: 25, fastestSolve: 0.9 });
  A(fl.flags.includes('abnormal_win_rate') && fl.flags.includes('long_win_streak') && fl.flags.includes('impossible_fastest_solve'), 'behavioural heuristics flag cheaters');

  /* ---- rate limiter ---- */
  const rl = new RateLimiter();
  let allowed = 0; for (let i = 0; i < 50; i++) if (rl.allow('u1', 'board:get')) allowed++;
  A(allowed <= 13 && allowed >= 10, 'rate limiter caps burst (board:get)');  // capacity 12
  A(rl.allow('u2', 'board:get'), 'different key has its own bucket');

  return { pass, fail, fails };
}

module.exports = { runUnit };

if (require.main === module) {
  const r = runUnit();
  console.log(`UNIT: ${r.pass} passed, ${r.fail} failed`);
  process.exit(r.fail ? 1 : 0);
}
