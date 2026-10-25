'use strict';
/*
 * Double Agent: Protocol Zero - the server-side referee.
 *
 * Golden rules:
 *  1. The browser never decides anything. It sends *requests*; this file validates them.
 *  2. Nobody receives the full game state. Every player gets a personal "view"
 *     built by viewFor(), containing only what that player may see.
 *  3. All timers, tallies, scores and winners are computed here.
 */
const crypto = require('crypto');
const { MISSIONS } = require('./missions');

// ---------- Settings (easy to tune) ----------
const TS = Number(process.env.TIME_SCALE) > 0 ? Number(process.env.TIME_SCALE) : 1; // tests use e.g. 0.05
const SECONDS = {
  reveal: 10,
  briefing: 8,
  filing: 20,
  investigate: 90,
  vote: 25,
  result: 12,
  final: 30,
};
const INVESTIGATE_MIN_SECONDS = 20; // "everyone is ready" cannot skip faster than this
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;
const DOUBLES = { 4: 1, 5: 2, 6: 2, 7: 3, 8: 3 };
const TEAM = { 4: 3, 5: 3, 6: 3, 7: 4, 8: 4 };
const MISSIONS_PER_GAME = 3;
const WINS_NEEDED = 2;
const MIN_CONNECTED_TO_CONTINUE = 3;
const ABORT_AFTER_MS = Math.max(1500, 60000 * TS);
const HOST_GRACE_MS = Math.max(400, 8000 * TS);
const IDLE_ROOM_MS = 30 * 60 * 1000;
const MAX_ROOMS = 300;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L or O (look like 1 and 0)
const CHAT_PHASES = new Set(['lobby', 'investigate', 'vote', 'results']);
const LABELS = 'ABCDEFGH';

const rooms = new Map();
const ipHits = new Map();

// ---------- Small helpers ----------
const rint = (n) => crypto.randomInt(n);
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rint(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const newId = () => crypto.randomBytes(4).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');

function cleanText(raw, min, max) {
  if (typeof raw !== 'string') return null;
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const n = Array.from(s).length;
  if (n < min || n > max) return null;
  return s;
}

function sendTo(conn, obj) {
  if (!conn || !conn.open) return;
  try { conn.send(JSON.stringify(obj)); } catch (e) { /* connection died */ }
}
const sendErr = (conn, code, text) => sendTo(conn, { t: 'error', code, text });
const sendOk = (conn, action, text) => sendTo(conn, { t: 'ok', action, text });

function ipLimited(ip, kind, max, windowMs) {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const arr = (ipHits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { ipHits.set(key, arr); return true; }
  arr.push(now);
  ipHits.set(key, arr);
  return false;
}

// ---------- Room helpers ----------
function makeCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_ALPHABET[rint(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function newPlayer(name) {
  return {
    id: newId(), token: newToken(), name,
    conn: null, connected: false, disconnectedAt: 0,
    ready: false, joinedAt: Date.now(), chatTimes: [],
  };
}

function connectedPlayers(room) {
  return room.order.map((id) => room.players.get(id)).filter((p) => p && p.connected);
}

function deleteRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.minTimer);
  rooms.delete(room.code);
}

function reassignHost(room) {
  const next = room.order.map((id) => room.players.get(id)).find((p) => p && p.connected)
    || room.players.get(room.order[0]);
  room.hostId = next ? next.id : null;
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  if (p.conn) p.conn.ctx = null;
  room.players.delete(id);
  room.order = room.order.filter((x) => x !== id);
  if (room.order.length === 0) return deleteRoom(room);
  if (room.hostId === id) reassignHost(room);
}

function attach(room, p, conn) {
  if (p.conn && p.conn !== conn) {
    const old = p.conn;
    old.ctx = null;
    sendTo(old, { t: 'replaced' });
    old.close(4000, 'opened elsewhere');
  }
  p.conn = conn;
  p.connected = true;
  p.disconnectedAt = 0;
  conn.ctx = { code: room.code, pid: p.id };
  room.lastActivity = Date.now();
  sendTo(conn, { t: 'joined', code: room.code, token: p.token, id: p.id });
  broadcast(room);
}

// ---------- Views: what each player is allowed to see ----------
function publicFacts(facts) {
  return facts.map((f) => ({ key: f.key, label: f.label, value: f.value }));
}

function publicHistory(g, revealFilers) {
  return g.history.map((h) => ({
    n: h.n, title: h.title, clean: h.clean, winner: h.winner,
    reports: h.reports.map((r) => ({
      label: r.label, forged: r.forged, approves: r.approves, rejects: r.rejects,
      approved: r.approved, correct: r.correct, votes: r.votes,
      ...(revealFilers ? { filer: r.filer } : {}),
    })),
  }));
}

function viewFor(room, p) {
  const g = room.game;
  const all = connectedPlayers(room);
  const v = {
    t: 'state',
    serverNow: Date.now(),
    code: room.code,
    phase: room.phase,
    pid: room.phaseId,
    phaseEnds: room.phaseEnds,
    phaseMs: room.phaseMs || 0,
    notice: room.notice || null,
    limits: { min: MIN_PLAYERS, max: MAX_PLAYERS },
    you: { id: p.id, name: p.name, host: room.hostId === p.id, ready: p.ready },
    players: room.order.map((id) => {
      const q = room.players.get(id);
      return { id: q.id, name: q.name, connected: q.connected, host: room.hostId === q.id, ready: q.ready };
    }),
    chat: room.chat.slice(-40).map((c) => ({ n: c.n, name: c.name, text: c.text, mine: c.pid === p.id })),
    connectedCount: all.length,
  };
  if (!g) return v;

  const isDouble = g.doubles.has(p.id);
  v.you.role = isDouble ? 'double' : 'loyal';
  if (isDouble) {
    v.you.partners = [...g.doubles].filter((id) => id !== p.id)
      .map((id) => ({ id, name: room.players.get(id).name }));
  }
  v.game = {
    missionNo: Math.min(g.missionIdx + 1, MISSIONS_PER_GAME),
    wins: g.wins,
    doublesCount: g.doubles.size,
    history: publicHistory(g, room.phase === 'results'),
  };

  const m = g.mission;
  const live = m && ['briefing', 'filing', 'investigate', 'vote', 'result'].includes(room.phase);
  if (live) {
    v.mission = {
      no: g.missionIdx + 1,
      title: m.tmpl.title,
      story: m.tmpl.story,
      labels: m.tmpl.facts.map((f) => ({ key: f.key, label: f.label })),
      team: m.team.map((id) => ({ id, name: room.players.get(id).name })),
    };
    if (isDouble) {
      v.mission.truth = m.tmpl.facts.map((f) => ({ key: f.key, label: f.label, value: f.truth }));
    }
    if (room.phase === 'filing' && m.filing[p.id]) {
      const f = m.filing[p.id];
      v.filing = {
        choice: f.choice,
        genuine: publicFacts(f.genuine),
        forged: isDouble && f.forged ? publicFacts(f.forged) : null,
      };
    }
    if (m.reports.length && room.phase !== 'briefing' && room.phase !== 'filing') {
      const reveal = room.phase === 'result' && m.result;
      v.reports = m.reports.map((r, i) => {
        const mine = r.filer === p.id;
        const out = { label: r.label, facts: publicFacts(r.facts), mine };
        if (mine) out.youFiled = r.forged ? 'forged' : 'genuine';
        if (reveal) {
          const res = m.result.reports[i];
          Object.assign(out, {
            forged: r.forged, approves: res.approves, rejects: res.rejects,
            approved: res.approved, correct: res.correct, votes: res.votes,
          });
        }
        return out;
      });
      if (reveal) v.mission.outcome = { clean: m.result.clean, winner: m.result.winner };
    }
    if (room.phase === 'investigate' || room.phase === 'vote') {
      v.verify = {
        available: !m.verifyUsed.has(p.id),
        results: m.verifyResults.get(p.id) || [],
        log: m.verifyLog,
      };
    }
    if (room.phase === 'investigate') {
      v.ready = { count: m.ready.size, total: all.length, you: m.ready.has(p.id) };
    }
    if (room.phase === 'vote') {
      v.vote = {
        submitted: m.submitted.has(p.id),
        count: m.submitted.size,
        total: all.length,
        mine: m.votes.get(p.id) || null,
      };
    }
  }
  if (room.phase === 'final') {
    v.final = {
      k: g.doubles.size,
      submitted: g.finalVotes.has(p.id),
      count: g.finalVotes.size,
      total: all.length,
    };
  }
  if (room.phase === 'results' && g.final) v.results = g.final;
  return v;
}

function broadcast(room) {
  for (const id of room.order) {
    const p = room.players.get(id);
    if (p && p.conn) sendTo(p.conn, viewFor(room, p));
  }
}

// ---------- Phase machine ----------
function setPhase(room, phase, seconds) {
  clearTimeout(room.timer);
  clearTimeout(room.minTimer);
  room.phase = phase;
  room.phaseId += 1;
  room.phaseEnds = seconds ? Date.now() + seconds * 1000 * TS : null;
  room.phaseMs = seconds ? seconds * 1000 * TS : 0;
  const id = room.phaseId;
  if (seconds) {
    room.timer = setTimeout(() => { if (room.phaseId === id) endPhase(room); }, seconds * 1000 * TS);
  }
  broadcast(room);
}

function endPhase(room) {
  const g = room.game;
  if (!g) return;
  switch (room.phase) {
    case 'reveal': return startMission(room);
    case 'briefing': return setPhase(room, 'filing', SECONDS.filing);
    case 'filing': return finishFiling(room);
    case 'investigate': return setPhase(room, 'vote', SECONDS.vote);
    case 'vote': return finishVote(room);
    case 'result': return afterResult(room);
    case 'final': return finishGame(room);
    default: return undefined;
  }
}

function startGame(room) {
  // Players who are not connected right now are dropped from the new game.
  for (const id of [...room.order]) {
    const p = room.players.get(id);
    if (p && !p.connected) removePlayer(room, id);
  }
  if (!rooms.has(room.code)) return;
  const ids = room.order.slice();
  const n = ids.length;
  const doubles = new Set(shuffle(ids).slice(0, DOUBLES[n]));
  const scoreParts = {};
  ids.forEach((id) => { scoreParts[id] = { votes: 0, forgeries: 0, accusations: 0, hidden: 0, win: 0 }; });
  room.notice = null;
  room.game = {
    doubles,
    missions: shuffle(MISSIONS).slice(0, MISSIONS_PER_GAME),
    missionIdx: 0,
    wins: { loyal: 0, double: 0 },
    scoreParts,
    history: [],
    finalVotes: new Map(),
    final: null,
    mission: null,
  };
  room.players.forEach((p) => { p.ready = false; });
  setPhase(room, 'reveal', SECONDS.reveal);
}

function startMission(room) {
  const g = room.game;
  const tmpl = g.missions[g.missionIdx];
  const ids = room.order.slice();
  const teamSize = TEAM[ids.length];
  const team = shuffle(ids).slice(0, teamSize);
  // Each report states 2 of the 5 facts. Cycling through a shuffled key list
  // guarantees every report has two different facts AND that some facts
  // appear in more than one report (so conflicts between reports are possible).
  const keyOrder = shuffle([0, 1, 2, 3, 4]);
  const filing = {};
  team.forEach((pid, j) => {
    const idxs = [keyOrder[(2 * j) % 5], keyOrder[(2 * j + 1) % 5]];
    const genuine = idxs.map((i) => ({ key: tmpl.facts[i].key, label: tmpl.facts[i].label, value: tmpl.facts[i].truth }));
    let forged = null;
    if (g.doubles.has(pid)) {
      const alter = rint(2);
      forged = idxs.map((i, k) => ({
        key: tmpl.facts[i].key,
        label: tmpl.facts[i].label,
        value: k === alter ? tmpl.facts[i].fake : tmpl.facts[i].truth,
      }));
    }
    filing[pid] = { genuine, forged, choice: null };
  });
  g.mission = {
    tmpl, team, filing, reports: [], result: null,
    verifyUsed: new Set(), verifyResults: new Map(), verifyLog: [],
    ready: new Set(), votes: new Map(), submitted: new Set(),
  };
  setPhase(room, 'briefing', SECONDS.briefing);
}

function finishFiling(room) {
  const m = room.game.mission;
  const entries = m.team.map((pid) => {
    const f = m.filing[pid];
    const useForged = f.choice === 'forged' && !!f.forged; // default = genuine
    return { filer: pid, facts: useForged ? f.forged : f.genuine, forged: useForged };
  });
  m.reports = shuffle(entries).map((e, i) => ({ label: LABELS[i], ...e }));
  setPhase(room, 'investigate', SECONDS.investigate);
  const id = room.phaseId;
  room.minTimer = setTimeout(() => {
    if (room.phaseId === id) maybeAdvance(room);
  }, INVESTIGATE_MIN_SECONDS * 1000 * TS + 30);
}

function maybeAdvance(room) {
  const g = room.game;
  if (!g) return;
  const conn = connectedPlayers(room);
  if (!conn.length) return;
  if (room.phase === 'investigate') {
    const elapsed = Date.now() - (room.phaseEnds - SECONDS.investigate * 1000 * TS);
    if (elapsed >= INVESTIGATE_MIN_SECONDS * 1000 * TS && conn.every((p) => g.mission.ready.has(p.id))) {
      setPhase(room, 'vote', SECONDS.vote);
    }
  } else if (room.phase === 'vote') {
    if (conn.every((p) => g.mission.submitted.has(p.id))) finishVote(room);
  } else if (room.phase === 'final') {
    if (conn.every((p) => g.finalVotes.has(p.id))) finishGame(room);
  }
}

function finishVote(room) {
  const g = room.game;
  const m = g.mission;
  const reports = m.reports.map((r) => {
    const votes = [];
    let approves = 0;
    let rejects = 0;
    for (const [voter, ballot] of m.votes) {
      if (typeof ballot[r.label] !== 'boolean') continue;
      votes.push({ id: voter, approve: ballot[r.label] });
      if (ballot[r.label]) approves += 1; else rejects += 1;
    }
    const approved = approves > rejects; // a tie counts as Reject
    const correct = approved === !r.forged;
    return { label: r.label, filer: r.filer, forged: r.forged, approves, rejects, approved, correct, votes };
  });
  const clean = reports.every((r) => r.correct);
  const winner = clean ? 'loyal' : 'double';
  m.result = { reports, clean, winner };
  g.wins[winner] += 1;

  // Scoring for this mission.
  for (const r of reports) {
    for (const vt of r.votes) {
      if (!g.doubles.has(vt.id) && vt.approve === !r.forged) g.scoreParts[vt.id].votes += 1;
    }
    if (r.forged && r.approved) {
      for (const d of g.doubles) g.scoreParts[d].forgeries += 2;
    }
  }
  g.history.push({ n: g.missionIdx + 1, title: m.tmpl.title, clean, winner, reports });
  setPhase(room, 'result', SECONDS.result);
}

function afterResult(room) {
  const g = room.game;
  const decided = g.wins.loyal >= WINS_NEEDED || g.wins.double >= WINS_NEEDED
    || g.missionIdx >= MISSIONS_PER_GAME - 1;
  if (decided) return setPhase(room, 'final', SECONDS.final);
  g.missionIdx += 1;
  return startMission(room);
}

function finishGame(room) {
  const g = room.game;
  const K = g.doubles.size;
  const tallies = {};
  room.order.forEach((id) => { tallies[id] = 0; });
  for (const list of g.finalVotes.values()) list.forEach((id) => { tallies[id] += 1; });

  // Exposed = the top vote-getters, up to K. A tie that would overflow the
  // remaining slots protects everyone in that tie.
  const groups = new Map();
  for (const [id, c] of Object.entries(tallies)) {
    if (c <= 0) continue;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(id);
  }
  const exposed = [];
  let remaining = K;
  for (const c of [...groups.keys()].sort((a, b) => b - a)) {
    const grp = groups.get(c);
    if (grp.length > remaining) break;
    exposed.push(...grp);
    remaining -= grp.length;
  }
  const allExposed = [...g.doubles].every((d) => exposed.includes(d));
  const missionsWin = g.wins.loyal >= WINS_NEEDED;
  const winner = missionsWin || allExposed ? 'loyal' : 'double';
  let reason;
  if (missionsWin) reason = 'The Loyal Agents secured the missions.';
  else if (allExposed) reason = 'The Doubles won the missions, but every one of them was exposed.';
  else reason = 'The Doubles sabotaged the missions and at least one stayed hidden.';

  // Final scoring.
  for (const [voter, list] of g.finalVotes) {
    if (g.doubles.has(voter)) continue;
    list.forEach((id) => { if (g.doubles.has(id)) g.scoreParts[voter].accusations += 2; });
  }
  for (const d of g.doubles) if (!exposed.includes(d)) g.scoreParts[d].hidden += 2;
  for (const id of room.order) {
    const isD = g.doubles.has(id);
    if ((winner === 'double') === isD) g.scoreParts[id].win += 3;
  }
  const name = (id) => room.players.get(id).name;
  const scores = room.order.map((id) => {
    const s = g.scoreParts[id];
    return {
      id, name: name(id), role: g.doubles.has(id) ? 'double' : 'loyal',
      score: s.votes + s.forgeries + s.accusations + s.hidden + s.win,
      parts: { ...s },
    };
  }).sort((a, b) => b.score - a.score);
  const best = scores.length ? scores[0].score : 0;

  g.final = {
    winner, reason, wins: g.wins, k: K,
    exposed,
    tallies: room.order.map((id) => ({ id, name: name(id), votes: tallies[id] })),
    scores,
    top: scores.filter((s) => s.score === best).map((s) => s.id),
    roles: room.order.map((id) => ({ id, name: name(id), role: g.doubles.has(id) ? 'double' : 'loyal' })),
    recap: g.history.map((h) => ({
      n: h.n, title: h.title, clean: h.clean, winner: h.winner,
      reports: h.reports.map((r) => ({
        label: r.label, filer: r.filer, filerName: name(r.filer), forged: r.forged,
        approves: r.approves, rejects: r.rejects, approved: r.approved, correct: r.correct, votes: r.votes,
      })),
    })),
  };
  g.mission = null;
  setPhase(room, 'results', 0);
}

function resetToLobby(room, notice) {
  clearTimeout(room.timer);
  clearTimeout(room.minTimer);
  room.game = null;
  room.phase = 'lobby';
  room.phaseId += 1;
  room.phaseEnds = null;
  room.notice = notice || null;
  room.players.forEach((p) => { p.ready = false; });
  if (!room.players.get(room.hostId) || !room.players.get(room.hostId).connected) reassignHost(room);
  broadcast(room);
}

// ---------- Messages from players ----------
function handleMessage(conn, raw) {
  const now = Date.now();
  conn.msgTimes = (conn.msgTimes || []).filter((t) => now - t < 5000);
  if (conn.msgTimes.length >= 30) return sendErr(conn, 'RATE', 'Slow down a little.');
  conn.msgTimes.push(now);

  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return sendErr(conn, 'BAD', 'That message was not understood.'); }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return sendErr(conn, 'BAD', 'That message was not understood.');

  if (msg.t === 'create') return doCreate(conn, msg);
  if (msg.t === 'join') return doJoin(conn, msg);
  if (msg.t === 'resume') return doResume(conn, msg);
  if (msg.t === 'ping') return sendTo(conn, { t: 'pong' });

  const ctx = conn.ctx;
  const room = ctx && rooms.get(ctx.code);
  const p = room && room.players.get(ctx.pid);
  if (!room || !p || p.conn !== conn) return sendErr(conn, 'NO_SEAT', 'You are not in a room. Join or create one first.');
  room.lastActivity = now;
  return act(room, p, conn, msg);
}

function doCreate(conn, msg) {
  if (conn.ctx) return sendErr(conn, 'BAD', 'You are already in a room.');
  if (ipLimited(conn.ip, 'create', 20, 60000)) return sendErr(conn, 'RATE', 'Too many rooms created. Wait a minute and try again.');
  const name = cleanText(msg.name, 2, 14);
  if (!name) return sendErr(conn, 'NAME', 'Pick a name between 2 and 14 characters.');
  if (rooms.size >= MAX_ROOMS) return sendErr(conn, 'BUSY', 'The server is full right now. Try again soon.');
  const code = makeCode();
  if (!code) return sendErr(conn, 'BUSY', 'Could not make a room code. Try again.');
  const p = newPlayer(name);
  const room = {
    code, players: new Map([[p.id, p]]), order: [p.id], hostId: p.id,
    phase: 'lobby', phaseId: 1, phaseEnds: null, timer: null, minTimer: null,
    game: null, chat: [], chatSeq: 0, notice: null, created: Date.now(), lastActivity: Date.now(),
  };
  rooms.set(code, room);
  attach(room, p, conn);
}

function normalizeCode(c) {
  const s = typeof c === 'string' ? c.trim().toUpperCase() : '';
  return /^[A-Z]{4}$/.test(s) ? s : null;
}

function doJoin(conn, msg) {
  if (conn.ctx) return sendErr(conn, 'BAD', 'You are already in a room.');
  if (ipLimited(conn.ip, 'join', 120, 60000)) return sendErr(conn, 'RATE', 'Too many attempts. Wait a minute and try again.');
  const code = normalizeCode(msg.code);
  if (!code) return sendErr(conn, 'NO_ROOM', 'Room codes are 4 letters, like KQTR.');
  const room = rooms.get(code);
  if (!room) return sendErr(conn, 'NO_ROOM', `There is no room ${code}. Check the code with your host.`);
  // A returning player who lost their page can still use their saved token.
  if (typeof msg.token === 'string') {
    const back = [...room.players.values()].find((x) => x.token === msg.token);
    if (back) return attach(room, back, conn);
  }
  if (room.phase !== 'lobby') return sendErr(conn, 'IN_PROGRESS', 'That game has already started. Ask the host to start a new one after this round.');
  if (room.players.size >= MAX_PLAYERS) return sendErr(conn, 'FULL', 'That room is full (8 players).');
  const name = cleanText(msg.name, 2, 14);
  if (!name) return sendErr(conn, 'NAME', 'Pick a name between 2 and 14 characters.');
  const taken = [...room.players.values()].some((x) => x.name.toLowerCase() === name.toLowerCase());
  if (taken) return sendErr(conn, 'NAME_TAKEN', 'Someone in this room already uses that name. Pick another.');
  const p = newPlayer(name);
  room.players.set(p.id, p);
  room.order.push(p.id);
  return attach(room, p, conn);
}

function doResume(conn, msg) {
  if (conn.ctx) return undefined;
  const code = normalizeCode(msg.code);
  const room = code && rooms.get(code);
  if (!room) return sendErr(conn, 'ROOM_GONE', 'That room no longer exists. Start or join a new one.');
  const p = typeof msg.token === 'string'
    && [...room.players.values()].find((x) => x.token === msg.token);
  if (!p) return sendErr(conn, 'NO_SEAT', 'Your seat in that room is gone. Join again with the code.');
  return attach(room, p, conn);
}

function stale(room, msg, conn) {
  if (msg.pid !== room.phaseId) {
    sendErr(conn, 'STALE', 'That moment already passed.');
    return true;
  }
  return false;
}

function act(room, p, conn, msg) {
  const g = room.game;
  const m = g && g.mission;
  switch (msg.t) {
    case 'lobbyReady': {
      if (room.phase !== 'lobby') return sendErr(conn, 'PHASE', 'Not available right now.');
      p.ready = !!msg.on;
      return broadcast(room);
    }
    case 'start': {
      if (room.phase !== 'lobby') return sendErr(conn, 'PHASE', 'The game has already started.');
      if (room.hostId !== p.id) return sendErr(conn, 'HOST', 'Only the host can start the game.');
      const n = connectedPlayers(room).length;
      if (n < MIN_PLAYERS) return sendErr(conn, 'FEW', `You need at least ${MIN_PLAYERS} players connected to start.`);
      return startGame(room);
    }
    case 'kick': {
      if (room.phase !== 'lobby') return sendErr(conn, 'PHASE', 'Players can only be removed in the lobby.');
      if (room.hostId !== p.id) return sendErr(conn, 'HOST', 'Only the host can remove players.');
      const target = room.players.get(msg.id);
      if (!target || target.id === p.id) return sendErr(conn, 'BAD', 'Pick another player.');
      const tc = target.conn;
      removePlayer(room, target.id);
      if (tc) { sendTo(tc, { t: 'kicked' }); tc.close(4001, 'removed'); }
      return rooms.has(room.code) ? broadcast(room) : undefined;
    }
    case 'leave': {
      if (room.phase === 'lobby' || room.phase === 'results') {
        const c = p.conn;
        const code = room.code;
        removePlayer(room, p.id);
        if (c) c.ctx = null;
        sendTo(c, { t: 'left' });
        const still = rooms.get(code);
        if (still) broadcast(still);
      } else {
        sendTo(conn, { t: 'left' });
      }
      return undefined;
    }
    case 'chat': {
      if (!CHAT_PHASES.has(room.phase)) return sendErr(conn, 'PHASE', 'Chat is closed during this step.');
      const text = cleanText(msg.text, 1, 140);
      if (!text) return sendErr(conn, 'BAD', 'Messages can be 1 to 140 characters.');
      const now = Date.now();
      p.chatTimes = p.chatTimes.filter((t) => now - t < 8000);
      if (p.chatTimes.length >= 5) return sendErr(conn, 'RATE', 'You are sending messages too fast.');
      p.chatTimes.push(now);
      room.chatSeq += 1;
      room.chat.push({ n: room.chatSeq, pid: p.id, name: p.name, text });
      if (room.chat.length > 80) room.chat.shift();
      return broadcast(room);
    }
    case 'again': {
      if (room.phase !== 'results') return sendErr(conn, 'PHASE', 'The game is not over yet.');
      if (room.hostId !== p.id) return sendErr(conn, 'HOST', 'Only the host can start another round.');
      room.chat = [];
      return resetToLobby(room, null);
    }
    default: break;
  }

  // Everything below happens inside a running game and must match the current phase.
  if (!g) return sendErr(conn, 'PHASE', 'There is no game running.');
  if (stale(room, msg, conn)) return undefined;

  switch (msg.t) {
    case 'file': {
      if (room.phase !== 'filing') return sendErr(conn, 'PHASE', 'Filing is closed.');
      const f = m.filing[p.id];
      if (!f) return sendErr(conn, 'NOT_ALLOWED', 'You are not on the field team this mission.');
      if (f.choice) return sendErr(conn, 'DUPLICATE', 'You already filed your report.');
      if (msg.choice !== 'genuine' && msg.choice !== 'forged') return sendErr(conn, 'BAD', 'Pick a report to file.');
      if (msg.choice === 'forged' && !f.forged) return sendErr(conn, 'NOT_ALLOWED', 'You cannot file that report.');
      f.choice = msg.choice;
      sendOk(conn, 'file', 'Report filed.');
      return broadcast(room);
    }
    case 'verify': {
      if (room.phase !== 'investigate') return sendErr(conn, 'PHASE', 'Verifying is only open while investigating.');
      if (m.verifyUsed.has(p.id)) return sendErr(conn, 'DUPLICATE', 'You already used your Verify this mission.');
      const r = m.reports.find((x) => x.label === msg.report);
      if (!r) return sendErr(conn, 'BAD', 'Pick a report.');
      if (r.filer === p.id) return sendErr(conn, 'OWN_REPORT', 'You cannot verify your own report.');
      const fact = r.facts.find((x) => x.key === msg.fact);
      if (!fact) return sendErr(conn, 'BAD', 'Pick one of the facts on that report.');
      const truth = m.tmpl.facts.find((x) => x.key === fact.key).truth;
      const result = fact.value === truth ? 'match' : 'mismatch';
      m.verifyUsed.add(p.id);
      const list = m.verifyResults.get(p.id) || [];
      list.push({ label: r.label, key: fact.key, factLabel: fact.label, result });
      m.verifyResults.set(p.id, list);
      m.verifyLog.push({ by: p.id, byName: p.name, label: r.label, key: fact.key, factLabel: fact.label });
      sendOk(conn, 'verify', result === 'match' ? 'Verified: it matches.' : 'Verified: it does NOT match.');
      return broadcast(room);
    }
    case 'ready': {
      if (room.phase !== 'investigate') return sendErr(conn, 'PHASE', 'Not available right now.');
      m.ready.add(p.id);
      broadcast(room);
      return maybeAdvance(room);
    }
    case 'vote': {
      if (room.phase !== 'vote') return sendErr(conn, 'PHASE', 'Voting is closed.');
      if (m.submitted.has(p.id)) return sendErr(conn, 'DUPLICATE', 'Your ballot is already locked in.');
      const need = m.reports.filter((r) => r.filer !== p.id).map((r) => r.label);
      const ballot = msg.votes;
      if (!ballot || typeof ballot !== 'object' || Array.isArray(ballot)) return sendErr(conn, 'BAD', 'Vote on every report.');
      const keys = Object.keys(ballot);
      const okShape = keys.length === need.length && need.every((l) => typeof ballot[l] === 'boolean');
      if (!okShape) return sendErr(conn, 'BAD', 'Vote on every report except your own.');
      const clean = {};
      need.forEach((l) => { clean[l] = ballot[l]; });
      m.votes.set(p.id, clean);
      m.submitted.add(p.id);
      sendOk(conn, 'vote', 'Ballot locked in.');
      broadcast(room);
      return maybeAdvance(room);
    }
    case 'final': {
      if (room.phase !== 'final') return sendErr(conn, 'PHASE', 'The suspect vote is not open.');
      if (g.finalVotes.has(p.id)) return sendErr(conn, 'DUPLICATE', 'Your suspects are already locked in.');
      const list = msg.suspects;
      const K = g.doubles.size;
      const valid = Array.isArray(list) && list.length === K
        && new Set(list).size === K
        && list.every((id) => typeof id === 'string' && id !== p.id && room.players.has(id));
      if (!valid) return sendErr(conn, 'BAD', `Pick exactly ${K} other player${K > 1 ? 's' : ''}.`);
      g.finalVotes.set(p.id, list.slice());
      sendOk(conn, 'final', 'Suspects locked in.');
      broadcast(room);
      return maybeAdvance(room);
    }
    default:
      return sendErr(conn, 'BAD', 'Unknown action.');
  }
}

// ---------- Connections and housekeeping ----------
function handleConnection(conn, ip) {
  conn.ip = ip;
  conn.ctx = null;
  conn.on('message', (raw) => handleMessage(conn, raw));
  conn.on('close', () => {
    const ctx = conn.ctx;
    if (!ctx) return;
    const room = rooms.get(ctx.code);
    const p = room && room.players.get(ctx.pid);
    if (!p || p.conn !== conn) return;
    p.conn = null;
    p.connected = false;
    p.disconnectedAt = Date.now();
    room.lastActivity = Date.now();
    broadcast(room);
    maybeAdvance(room);
  });
}

function tick() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const connected = connectedPlayers(room);
    const host = room.players.get(room.hostId);
    if (host && !host.connected && connected.length && now - host.disconnectedAt >= HOST_GRACE_MS) {
      reassignHost(room);
      broadcast(room);
    }
    if (room.game && room.phase !== 'results') {
      if (connected.length < MIN_CONNECTED_TO_CONTINUE) {
        if (!room.lowSince) room.lowSince = now;
        if (now - room.lowSince >= ABORT_AFTER_MS) {
          room.lowSince = 0;
          resetToLobby(room, 'The game was called off because too many players left.');
        }
      } else {
        room.lowSince = 0;
      }
    } else {
      room.lowSince = 0;
    }
    if (!connected.length && now - room.lastActivity > IDLE_ROOM_MS) deleteRoom(room);
  }
  for (const [k, arr] of ipHits) {
    const fresh = arr.filter((t) => now - t < 120000);
    if (fresh.length) ipHits.set(k, fresh); else ipHits.delete(k);
  }
}

module.exports = { handleConnection, tick, stats: () => ({ rooms: rooms.size }) };
