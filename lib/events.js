/* ============================================================
   SPIRAL RUSH — events (global, limited-time)
   ------------------------------------------------------------
   Deterministic worldwide schedule (no admin needed):
   events run every weekend (Fri 00:00 → Sun 23:59:59 UTC),
   the type rotates each week. Pure & testable.
   ============================================================ */
'use strict';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const EVENT_TYPES = [
  { id: 'double_score',  name: 'Double Score Weekend', desc: 'All score gains are doubled.',          kind: 'mult',    value: 2 },
  { id: 'speed_festival', name: 'Speed Festival',      desc: 'Huge bonus for fast solves.',           kind: 'speed',   value: 300 },
  { id: 'marathon',      name: 'Marathon',             desc: 'Bonus points for every game played.',   kind: 'pergame', value: 60 },
  { id: 'summit_climb',  name: 'Summit Climb',         desc: 'Bonus for reaching deeper levels.',     kind: 'level',   value: 15 }
];

const DAY = 86400000;
function dayIndex(d) { return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY); }
function weekIndex(d) { return Math.floor((dayIndex(d) + 3) / 7); } // anchor so weeks rotate cleanly
function isWeekend(d) { const w = d.getUTCDay(); return w === 5 || w === 6 || w === 0; } // Fri, Sat, Sun

/* the Fri 00:00 → Sun 23:59:59.999 window containing date d (if it's a weekend) */
function weekendWindow(d) {
  const w = d.getUTCDay();
  const back = w === 5 ? 0 : w === 6 ? 1 : w === 0 ? 2 : null;
  if (back == null) return null;
  const fri = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back, 0, 0, 0, 0);
  const end = fri + 3 * DAY - 1;
  return { start: fri, end };
}
function typeForWeek(d) { return EVENT_TYPES[((weekIndex(d) % EVENT_TYPES.length) + EVENT_TYPES.length) % EVENT_TYPES.length]; }

/* currently active event (or null) */
function activeEvent(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!isWeekend(d)) return null;
  const win = weekendWindow(d); if (!win) return null;
  const t = typeForWeek(d);
  return { ...t, start: win.start, end: win.end, weekId: weekIndex(d) };
}

/* the next upcoming event (this weekend if before it, else next weekend) */
function upcomingEvent(date) {
  const d = date instanceof Date ? date : new Date(date);
  // find the next Friday 00:00 UTC strictly in the future (or today if today is Friday and before window already handled by activeEvent)
  let probe = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  for (let i = 0; i < 8; i++) {
    if (probe.getUTCDay() === 5 && probe.getTime() > d.getTime()) break;
    probe = new Date(probe.getTime() + DAY);
  }
  const win = { start: probe.getTime(), end: probe.getTime() + 3 * DAY - 1 };
  const t = EVENT_TYPES[((weekIndex(probe) % EVENT_TYPES.length) + EVENT_TYPES.length) % EVENT_TYPES.length];
  return { ...t, start: win.start, end: win.end, weekId: weekIndex(probe) };
}

/* event points bonus for one result. basePts = normal points already computed. */
function eventBonus(event, basePts, result) {
  if (!event) return 0;
  switch (event.kind) {
    case 'mult':    return Math.round(basePts * (event.value - 1));
    case 'speed':   return result.won ? Math.round(clamp(event.value - (result.solveTime || 999) * 3, 0, event.value)) : 0;
    case 'pergame': return event.value;
    case 'level':   return Math.round((result.level || 0) * event.value);
    default:        return 0;
  }
}

module.exports = { EVENT_TYPES, activeEvent, upcomingEvent, eventBonus, weekIndex, isWeekend, weekendWindow };
