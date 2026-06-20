# 🌀 Spiral Rush — Real-Time Multiplayer Maze Racer

Race 2–4 real players through a spiral maze. First to reach the center wins!

## 🎮 Play

```bash
npm install
npm start
```

Open `http://localhost:3000` in browser. Open 2-3 tabs to start a match.

## 🧪 Test

```bash
npm test
```

42 tests: unit + integration + adversarial (anti-cheat, rate-limit, player-limits, private rooms)

## 📁 Project Structure

```
spiral-rush/
├── server.js              ← Main server (Express + Socket.io)
├── package.json
├── public/
│   └── index.html         ← Game client (UI + gameplay + platform)
├── lib/
│   ├── scoring.js          ← Global Score, 10 pro ranks, achievements, missions, seasons
│   ├── platform.js         ← Leaderboards, friends, ghosts, notifications, profiles
│   ├── store.js            ← File-based persistence (data/players.json)
│   ├── cosmetics.js        ← Avatars, borders, titles + unlock rules
│   ├── events.js           ← Limited-time weekend events
│   ├── integrity.js        ← Server-authoritative anti-cheat validation
│   ├── ratelimit.js        ← Token-bucket rate limiter
│   └── log.js              ← Structured logger
├── test/
│   ├── run.js              ← Test runner (npm test)
│   ├── unit.test.js        ← Unit tests (scoring, cosmetics, events, integrity)
│   └── integration.test.js ← Integration + adversarial tests (live server)
└── data/
    └── .gitkeep            ← players.json auto-created here
```

## ✨ Features

**Core Game**
- Real-time multiplayer (2-3 players, random global matchmaking)
- Choose 2-Player or 3-Player match before entering
- Dynamic difficulty (maze grows with level)
- Rankings by solve time (fastest wins)
- Arrow keys / WASD / D-pad / swipe controls

**Competitive Platform**
- Global Score + 10 pro ranks (Bronze → World Champion)
- Leaderboards: Top 10, Top 100, Country, Daily, Weekly, Monthly, All-Time, Season
- Player stats, achievements (12), daily missions, streaks
- Daily Impossible Maze (same worldwide) + daily leaderboard
- Seasons (3-month, rankings reset, stats saved)

**Social**
- Friends: request, accept/reject, remove, online presence, friend profiles
- Private rooms: create with code, invite friends, 2-4 players
- Ghost runs: race your best or World #1 (server-stored, cross-device)
- Cosmetics: avatar symbols, colors, borders, titles (skill-unlocked, server-guarded)
- Limited-time weekend events with bonus scoring
- Notifications inbox with unread badge

**Production**
- Server-authoritative anti-cheat (impossibly-fast finishes rejected)
- Rate limiting (per-event token bucket)
- Graceful shutdown (SIGTERM/SIGINT flush data, clean exit)
- Health probes: GET /health, /healthz
- Structured logging (LOG_JSON=1 for aggregators)
- Crash isolation (uncaught exceptions logged, process stays up)
- Docker support (Dockerfile included)

## 🚀 Deploy

Works on any platform that supports Node.js + WebSockets:
- **Render.com** (recommended, free)
- **Railway.app**
- **Fly.io**
- **DigitalOcean** ($6/month)

Set `PORT` via environment variable if needed.

## 📜 License

MIT
