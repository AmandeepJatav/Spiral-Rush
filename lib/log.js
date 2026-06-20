/* ============================================================
   SPIRAL RUSH — structured logger
   File: lib/log.js
   ------------------------------------------------------------
   Tiny dependency-free structured logger. JSON lines in
   production (LOG_JSON=1) for log aggregators, pretty in dev.
   ============================================================ */
'use strict';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
const JSON_MODE = process.env.LOG_JSON === '1';

function emit(level, msg, fields) {
  if (LEVELS[level] < MIN) return;
  const rec = { ts: new Date().toISOString(), level, msg, ...(fields || {}) };
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(rec) + '\n');
  } else {
    const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
    const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
    const line = `[${rec.ts}] ${tag} ${msg}${extra}\n`;
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
  }
}

module.exports = {
  debug: (m, f) => emit('debug', m, f),
  info:  (m, f) => emit('info', m, f),
  warn:  (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
};
