/* ============================================================
   SPIRAL RUSH — cosmetics (avatars · borders · titles)
   ------------------------------------------------------------
   Pure logic. IDs here MUST match the client renderer.
   Unlock rules derive purely from a player's saved state.
   ============================================================ */
'use strict';
const SC = require('./scoring');

/* avatar symbols — some default, some unlocked by play */
const SYMBOLS = [
  { id: 'orb',      name: 'Orb',       unlock: null },
  { id: 'ring',     name: 'Ring',      unlock: null },
  { id: 'triangle', name: 'Triangle',  unlock: null },
  { id: 'square',   name: 'Square',    unlock: null },
  { id: 'star',     name: 'Star',      unlock: p => p.achievements.win_5 },
  { id: 'bolt',     name: 'Bolt',      unlock: p => p.achievements.speed_30 },
  { id: 'hex',      name: 'Hexagon',   unlock: p => p.achievements.level_20 },
  { id: 'flame',    name: 'Flame',     unlock: p => p.achievements.streak_10 },
  { id: 'diamond',  name: 'Diamond',   unlock: p => tierIdx(p) >= 4 },
  { id: 'crown',    name: 'Crown',     unlock: p => tierIdx(p) >= 9 }
];

/* tier index of a player from cached global score */
function tierIdx(p) { return SC.tierFor(p.scoreCache || 0).idx; }

/* borders — tier borders by tier index, plus special borders */
const BORDERS = [
  { id: 'none',        name: 'None',          unlock: null },
  { id: 'bronze',      name: 'Bronze',        tier: 0 },
  { id: 'silver',      name: 'Silver',        tier: 1 },
  { id: 'gold',        name: 'Gold',          tier: 2 },
  { id: 'platinum',    name: 'Platinum',      tier: 3 },
  { id: 'diamond',     name: 'Diamond',       tier: 4 },
  { id: 'master',      name: 'Master',        tier: 5 },
  { id: 'grandmaster', name: 'Grandmaster',   tier: 6 },
  { id: 'legend',      name: 'Legend',        tier: 7 },
  { id: 'mythic',      name: 'Mythic',        tier: 8 },
  { id: 'champion',    name: 'World Champion', tier: 9 },
  { id: 'streak',      name: 'Inferno',       unlock: p => p.achievements.streak_10 },
  { id: 'daily',       name: 'Daily Devotee', unlock: p => p.achievements.daily_7 },
  { id: 'event',       name: 'Event',         unlock: p => p.eventBadges && Object.keys(p.eventBadges).length > 0 }
];

/* selectable titles ('auto' = the computed performance title) */
const TITLES = [
  { id: 'auto',           name: 'Auto',           unlock: null },
  { id: 'speed_demon',    name: 'Speed Demon',    unlock: p => p.achievements.speed_30 },
  { id: 'unstoppable',    name: 'Unstoppable',    unlock: p => p.achievements.streak_10 },
  { id: 'maze_master',    name: 'Maze Master',    unlock: p => p.achievements.level_30 },
  { id: 'veteran',        name: 'Veteran',        unlock: p => p.achievements.win_25 },
  { id: 'world_champion', name: 'World Champion', unlock: p => tierIdx(p) >= 9 },
  { id: 'event_champ',    name: 'Event Champion', unlock: p => p.eventBadges && Object.keys(p.eventBadges).length > 0 }
];

function isUnlocked(item, player) {
  if (item.unlock == null && item.tier == null) return true;
  if (typeof item.tier === 'number') return tierIdx(player) >= item.tier;
  return !!item.unlock(player);
}

function unlockedSets(player) {
  return {
    symbols: SYMBOLS.filter(s => isUnlocked(s, player)).map(s => s.id),
    borders: BORDERS.filter(b => isUnlocked(b, player)).map(b => b.id),
    titles:  TITLES.filter(t => isUnlocked(t, player)).map(t => t.id)
  };
}

/* grant any newly-earned cosmetics (idempotent); returns the new ones */
function grantNewUnlocks(player) {
  if (!player.unlocks) player.unlocks = { symbols: {}, borders: {}, titles: {} };
  const now = Date.now(), out = [];
  const sets = unlockedSets(player);
  const map = { symbols: SYMBOLS, borders: BORDERS, titles: TITLES };
  for (const kind of ['symbols', 'borders', 'titles']) {
    for (const id of sets[kind]) {
      if (id === 'none' || id === 'auto') continue;
      if (!player.unlocks[kind][id]) {
        player.unlocks[kind][id] = now;
        const def = map[kind].find(x => x.id === id);
        out.push({ kind, id, name: def ? def.name : id });
      }
    }
  }
  return out;
}

function defaultAvatar() { return { symbol: 'orb', color: '#4a86e8', border: 'none' }; }

/* server-side guard: only allow unlocked cosmetics */
function sanitizeAvatar(player, avatar) {
  const cur = player.avatar || defaultAvatar();
  const sets = unlockedSets(player);
  const out = { symbol: cur.symbol, color: cur.color, border: cur.border };
  if (avatar && typeof avatar.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(avatar.color)) out.color = avatar.color;
  if (avatar && sets.symbols.includes(avatar.symbol)) out.symbol = avatar.symbol;
  if (avatar && sets.borders.includes(avatar.border)) out.border = avatar.border;
  return out;
}
function sanitizeTitle(player, titleId) {
  const sets = unlockedSets(player);
  return sets.titles.includes(titleId) ? titleId : 'auto';
}

/* resolve the title text to show */
function titleText(player) {
  const id = player.activeTitle || 'auto';
  if (id !== 'auto') { const def = TITLES.find(t => t.id === id); if (def && isUnlocked(def, player)) return def.name; }
  return SC.titleFor(player);
}

module.exports = {
  SYMBOLS, BORDERS, TITLES, tierIdx, isUnlocked, unlockedSets,
  grantNewUnlocks, defaultAvatar, sanitizeAvatar, sanitizeTitle, titleText
};
