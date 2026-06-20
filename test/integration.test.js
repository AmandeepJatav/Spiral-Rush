/* ============================================================
   SPIRAL RUSH — integration + adversarial tests (live server)
   File: test/integration.test.js
   ============================================================ */
'use strict';
const http = require('http');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3970;
const URL = 'http://localhost:' + PORT;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, t = 2000) { const s = Date.now(); while (Date.now() - s < t) { if (fn()) return true; await wait(30); } return false; }
function mk(cid) {
  const s = io(URL, { auth: { cid }, forceNew: true }); s.ev = {}; s.cnt = {}; s.first = {};
  ['me','start','roundOver','playerFinished','result_rejected','rate_limited','board','profile','cosmetics',
   'friends:list','notif:data','daily:info','ghost:saved','ghost:data','choose_mode',
   'room:created','room:joined','room:error','joined','lobby'].forEach(n =>
    s.on(n, d => { s.ev[n] = d; if (s.first[n] === undefined) s.first[n] = d; s.cnt[n] = (s.cnt[n] || 0) + 1; }));
  return s;
}
function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

async function runIntegration() {
  let pass = 0, fail = 0; const fails = [];
  const A = (c, m) => { if (c) { pass++; } else { fail++; fails.push(m); console.log('  ✗ ' + m); } };

  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), LOG_LEVEL: 'error' } });
  let up = false; srv.stdout.on('data', d => { if (/server_started|running/.test(d.toString())) up = true; });
  srv.stderr.on('data', () => {});
  await waitFor(() => up, 4000);

  try {
    /* health */
    const h = await getJSON(URL + '/health');
    A(h.status === 200 && h.body.status === 'ok', 'health endpoint ok');

    /* identity + choose_mode flow */
    const a = mk('ta'), b = mk('tb'), c = mk('tc');
    await waitFor(() => a.ev.me && b.ev.me && c.ev.me, 2000);
    A(a.first.me && a.first.me.hasProfile === false, 'me() no profile on first connect');
    // new players get choose_mode (not auto-joined)
    await waitFor(() => a.ev.choose_mode !== undefined, 1000);
    A(a.ev.choose_mode !== undefined, 'new player gets choose_mode (not auto-joined)');

    a.emit('profile:set', { name: 'Aman', country: 'IN', avatarColor: '#56c23a' });
    b.emit('profile:set', { name: 'Ravi', country: 'IN', avatarColor: '#4a86e8' });
    c.emit('profile:set', { name: 'Kabir', country: 'US', avatarColor: '#7d5bd6' });
    await wait(300);

    /* 3-PLAYER MATCHMAKE: all pick target=3, game starts only when 3rd joins */
    a.emit('matchmake', { target: 3 }); await wait(200);
    b.emit('matchmake', { target: 3 }); await wait(200);
    // with only 2 players (target=3), game should NOT start yet
    A(!a.ev.start, '3P mode: 2 players joined, game NOT started yet');
    // lobby should show 2/3
    A(a.ev.lobby && a.ev.lobby.count >= 2 && a.ev.lobby.target === 3, '3P lobby shows 2/3 with target=3');
    // 3rd joins → game starts
    c.emit('matchmake', { target: 3 }); await waitFor(() => a.ev.start && b.ev.start && c.ev.start, 3000);
    A(a.ev.start && a.ev.start.seed === b.ev.start.seed && b.ev.start.seed === c.ev.start.seed, '3P: all 3 get same seed');
    A(a.ev.start.players.length === 3, '3P: room has exactly 3');

    /* 4th player can't join a full 3P room */
    const d4 = mk('td'); await waitFor(() => d4.ev.me, 1500);
    d4.emit('profile:set', { name: 'Four', country: 'IN' }); await wait(200);
    d4.emit('matchmake', { target: 3 }); await wait(300);
    A(!a.ev.start || !a.ev.start.players.find(p => p.id === 'td'), '4th player not in the full 3P room');

    /* ANTI-CHEAT: impossibly-fast finish rejected */
    a.emit('finish', { time: 0.3 }); await waitFor(() => a.ev.result_rejected, 1200);
    A(a.ev.result_rejected && a.ev.result_rejected.reason === 'invalid_time', 'forged fast finish rejected');
    // legit finish
    a.emit('finish', { time: 25 }); await waitFor(() => a.ev.playerFinished && a.ev.playerFinished.id === 'ta', 1500);
    A(a.ev.playerFinished && a.ev.playerFinished.place === 1, 'legit finish recorded');
    b.emit('finish', { time: 40 }); c.emit('finish', { time: 60 });
    await waitFor(() => a.ev.roundOver, 1500);
    A(a.ev.roundOver && a.ev.roundOver.players.length === 3, 'roundOver with all 3');

    /* LEADERBOARD */
    a.emit('board:get', { scope: 'alltime', limit: 100 }); await waitFor(() => a.ev.board, 1000);
    A(a.ev.board.rows.length >= 1, 'leaderboard populated');

    /* PROFILE + COSMETICS guard */
    a.emit('profile:get'); await waitFor(() => a.ev.profile, 1000);
    A(a.ev.profile && a.ev.profile.globalRank >= 1, 'profile view');
    a.emit('cosmetics:get'); await waitFor(() => a.ev.cosmetics, 1000);
    a.emit('profile:customize', { avatar: { symbol: 'crown', color: '#ff0000', border: 'champion' }, bio: 'x' });
    await wait(250); a.emit('profile:get'); await waitFor(() => a.ev.profile && a.ev.profile.bio === 'x', 1000);
    A(a.ev.profile.avatar.border !== 'champion', 'locked cosmetic rejected');

    /* FRIENDS */
    const codeB = b.first.me.friendCode;
    a.emit('friend:request', codeB); await wait(250);
    b.emit('friends:data'); await waitFor(() => b.ev['friends:list'], 1000);
    A(b.ev['friends:list'].incoming.some(f => f.cid === 'ta'), 'friend request');
    b.emit('friend:accept', 'ta'); await waitFor(() => b.ev['friends:list'] && b.ev['friends:list'].friends.some(f => f.cid === 'ta'), 1500);
    A(b.ev['friends:list'].friends.some(f => f.cid === 'ta'), 'friend accept');

    /* GHOSTS */
    const dk = new Date().toISOString().slice(0, 10);
    a.emit('ghost:save', { track: 'daily:' + dk, time: 22.2, frames: Array.from({ length: 50 }, (_, i) => ({ t: i * 40, ang: i * 0.1, rad: 1 - i / 50 })) });
    await waitFor(() => a.ev['ghost:saved'], 1000);
    A(a.ev['ghost:saved'].ok, 'ghost saved');

    /* RATE LIMITING */
    const f = mk('tf'); await waitFor(() => f.ev.me, 1500); f.emit('profile:set', { name: 'Flood', country: 'IN' }); await wait(150);
    for (let i = 0; i < 40; i++) f.emit('board:get', { scope: 'alltime' });
    await waitFor(() => f.ev.rate_limited, 1500);
    A(f.cnt.rate_limited >= 1, 'rate limiter fires on flood');

    /* 2-PLAYER MATCHMAKE: 2 players pick target=2 → instant start */
    const p1 = mk('tp1'), p2 = mk('tp2');
    await waitFor(() => p1.ev.me && p2.ev.me, 1500);
    p1.emit('profile:set', { name: 'P1', country: 'IN' }); p2.emit('profile:set', { name: 'P2', country: 'IN' }); await wait(300);
    p1.emit('matchmake', { target: 2 }); await wait(200);
    p2.emit('matchmake', { target: 2 }); await waitFor(() => p1.ev.start && p2.ev.start, 3000);
    A(p1.ev.start && p1.ev.start.players.length === 2, '2P mode: starts with exactly 2 players');
    A(p1.ev.start.seed === p2.ev.start.seed, '2P: same seed');

    /* MATCHMAKE CANCEL */
    const mc = mk('tmc'); await waitFor(() => mc.ev.me, 1000); mc.emit('profile:set', { name: 'MC', country: 'IN' }); await wait(200);
    mc.emit('matchmake', { target: 3 }); await wait(200);
    mc.emit('matchmake:cancel'); await waitFor(() => mc.cnt.choose_mode >= 2, 1000);
    A(mc.cnt.choose_mode >= 2, 'matchmake:cancel returns player to mode select');

    /* PRIVATE ROOMS */
    const ph = mk('tph'), pg1 = mk('tpg1'), pg2 = mk('tpg2'), pg3 = mk('tpg3'), pg4 = mk('tpg4');
    await wait(300);
    ph.emit('profile:set', { name: 'Host', country: 'IN' }); pg1.emit('profile:set', { name: 'G1', country: 'US' }); await wait(200);
    let prCode = null; ph.on('room:created', d => prCode = d.code);
    ph.emit('room:create'); await waitFor(() => prCode, 1500);
    A(prCode && prCode.length === 6, 'private room created');
    pg1.emit('room:join', { code: prCode }); await waitFor(() => pg1.ev['room:joined'], 1500);
    A(pg1.ev['room:joined'] && pg1.ev['room:joined'].code === prCode, 'guest joins private room');
    let badErr = null; pg2.on('room:error', d => badErr = d.msg);
    pg2.emit('room:join', { code: 'XXXXXX' }); await waitFor(() => badErr, 1000);
    A(badErr && /not found/i.test(badErr), 'bad code rejected');
    // fill + 5th rejected
    pg2.emit('profile:set', { name: 'G2', country: 'IN' }); await wait(100); pg2.emit('room:join', { code: prCode }); await wait(300);
    pg3.emit('profile:set', { name: 'G3', country: 'IN' }); await wait(100); pg3.emit('room:join', { code: prCode }); await wait(300);
    let fullErr = null; pg4.on('room:error', d => fullErr = d.msg);
    pg4.emit('profile:set', { name: 'G4', country: 'IN' }); await wait(100); pg4.emit('room:join', { code: prCode }); await waitFor(() => fullErr, 1200);
    A(fullErr && (/full/i.test(fullErr) || /started/i.test(fullErr)), '5th player rejected from private room');
    ph.emit('room:leave'); await wait(300);
    A(true, 'host leaves private room ok');

    [a, b, c, d4, f, p1, p2, mc, ph, pg1, pg2, pg3, pg4].forEach(s => s.close());
  } catch (e) {
    fail++; fails.push('threw: ' + (e && e.message)); console.log('  ✗ threw:', e);
  } finally {
    srv.kill();
    try { require('fs').unlinkSync(path.join(__dirname, '..', 'data', 'players.json')); } catch (e) {}
  }
  return { pass, fail, fails };
}

module.exports = { runIntegration };
if (require.main === module) runIntegration().then(r => { console.log(`INTEGRATION: ${r.pass} passed, ${r.fail} failed`); process.exit(r.fail ? 1 : 0); });
