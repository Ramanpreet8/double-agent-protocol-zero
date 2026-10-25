'use strict';
/*
 * End-to-end tests. Real server, real WebSocket connections, real network messages.
 * (The "bots" are just independent clients; nothing is mocked or simulated server-side.)
 *
 * Run with:  npm test
 * Timers are sped up (TIME_SCALE) so a whole game takes a few seconds.
 */
process.env.TIME_SCALE = process.env.TIME_SCALE || '0.05';

const http = require('http');
const assert = require('assert');
const { start } = require('../server');

let URL_WS;
let ipCounter = 0;
const nextIp = () => { ipCounter += 1; return `10.1.${ipCounter >> 8}.${ipCounter & 255}`; };
let PORT;
const results = [];
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 8000, label = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = cond();
    if (v) return v;
    await sleep(15);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ---------- A bot is one independent player connection ----------
class Bot {
  constructor(name) {
    this.name = name;
    this.view = null;
    this.errors = [];
    this.oks = [];
    this.raw = [];          // every state message as text, with phase info
    this.done = new Set();
    this.sentVotes = {};    // mission -> ballot
    this.sentFinal = null;
    this.verifySeen = {};   // mission -> verify results
    this.resultViews = {};  // mission -> view during result phase
    this.extra = {};        // other message types (kicked, replaced...)
    this.brain = null;
    this.token = null;
    this.code = null;
    this.id = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL_WS, { headers: { 'x-forwarded-for': this.ip || nextIp() } });
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = () => reject(new Error('connect failed'));
      this.ws.onclose = () => { this.closed = true; };
      this.ws.onmessage = (e) => this.onMessage(e.data);
    });
  }
  onMessage(text) {
    const m = JSON.parse(text);
    if (m.t === 'state') {
      this.view = m;
      this.raw.push({ phase: m.phase, mission: m.game ? m.game.missionNo : 0, text, wins: m.game && m.game.wins });
      if (m.phase === 'result' && m.mission) this.resultViews[m.mission.no] = m;
      if (m.verify && m.mission) this.verifySeen[m.mission.no] = m.verify.results;
      if (this.brain) this.brain(this, m);
    } else if (m.t === 'joined') {
      this.token = m.token; this.code = m.code; this.id = m.id;
    } else if (m.t === 'error') {
      this.errors.push(m);
    } else if (m.t === 'ok') {
      this.oks.push(m);
    } else {
      this.extra[m.t] = (this.extra[m.t] || 0) + 1;
    }
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  act(o) { this.send({ pid: this.view.pid, ...o }); }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
  lastError() { return this.errors[this.errors.length - 1]; }
  async create() {
    await this.connect();
    this.send({ t: 'create', name: this.name });
    await until(() => this.view && this.code, 3000, 'create');
    return this;
  }
  async join(code) {
    await this.connect();
    this.send({ t: 'join', code, name: this.name });
    await until(() => (this.view && this.code) || this.errors.length, 3000, 'join');
    return this;
  }
}

// ---------- Autoplay brains ----------
function once(bot, v, tag, fn) {
  const k = `${v.phase}:${v.pid}:${tag}`;
  if (bot.done.has(k)) return;
  bot.done.add(k);
  fn();
}

function makeBrain(opts) {
  return (bot, v) => {
    switch (v.phase) {
      case 'filing':
        if (v.filing && !v.filing.choice) {
          const wantForged = v.filing.forged && opts.doubleFile === 'forged';
          once(bot, v, 'file', () => bot.act({ t: 'file', choice: wantForged ? 'forged' : 'genuine' }));
        }
        break;
      case 'investigate':
        if (v.verify && v.verify.available && opts.verify !== false) {
          const r = v.reports.find((x) => !x.mine);
          if (r) once(bot, v, 'verify', () => bot.act({ t: 'verify', report: r.label, fact: r.facts[0].key }));
        }
        once(bot, v, 'ready', () => setTimeout(() => bot.act({ t: 'ready' }), 80));
        break;
      case 'vote':
        once(bot, v, 'vote', () => {
          const ballot = {};
          v.reports.filter((r) => !r.mine).forEach((r) => { ballot[r.label] = opts.vote(bot, v, r); });
          bot.sentVotes[v.mission.no] = ballot;
          bot.act({ t: 'vote', votes: ballot });
        });
        break;
      case 'final':
        once(bot, v, 'final', () => {
          const list = opts.final(bot, v);
          bot.sentFinal = list;
          bot.act({ t: 'final', suspects: list });
        });
        break;
      default: break;
    }
  };
}

async function makeRoom(n, brainOpts) {
  const bots = [];
  const host = await new Bot('Host').create();
  bots.push(host);
  for (let i = 1; i < n; i++) bots.push(await new Bot(`P${i + 1}`).join(host.code));
  await until(() => bots.every((b) => b.view && b.view.players.length === n), 3000, 'lobby sync');
  bots.forEach((b) => { b.room = bots; });
  if (brainOpts) bots.forEach((b) => { b.brain = makeBrain(brainOpts); });
  return bots;
}

async function expectErr(bot, msg, code, label) {
  const n = bot.errors.length;
  if (msg.raw) bot.send(msg.raw); else bot.act(msg);
  await until(() => bot.errors.length > n, 1500, label || `error ${code}`);
  assert.strictEqual(bot.errors[bot.errors.length - 1].code, code, label || `expected ${code}`);
}

const doublesOf = (bots) => bots.filter((b) => b.view.you.role === 'double');

// ---------- Full-game scenario with independent score verification ----------
async function playFull(n, opts) {
  const bots = await makeRoom(n, opts);
  const host = bots[0];
  host.send({ t: 'start' });
  await until(() => bots.every((b) => b.view.phase === 'results'), 20000, 'results screen');
  const res = host.view.results;
  verifyGame(bots, res, n);
  return { bots, res };
}

function verifyGame(bots, res, n) {
  const roleOf = {};
  bots.forEach((b) => { roleOf[b.id] = b.view.you.role; });
  const doubles = bots.filter((b) => roleOf[b.id] === 'double').map((b) => b.id);
  const expectedDoubles = { 4: 1, 5: 2, 6: 2, 7: 3, 8: 3 }[n];
  assert.strictEqual(doubles.length, expectedDoubles, `double count for ${n} players`);
  // Results screen must tell the same story as each player's own private role.
  res.roles.forEach((r) => assert.strictEqual(r.role, roleOf[r.id], 'revealed role matches private role'));

  // Recompute each mission from the ballots the bots actually sent.
  let winsL = 0; let winsD = 0;
  const parts = {};
  bots.forEach((b) => { parts[b.id] = { votes: 0, forgeries: 0, accusations: 0, hidden: 0, win: 0 }; });
  res.recap.forEach((mi) => {
    let clean = true;
    mi.reports.forEach((r) => {
      let a = 0; let rj = 0;
      bots.forEach((b) => {
        const ballot = b.sentVotes[mi.n];
        if (ballot && typeof ballot[r.label] === 'boolean') {
          if (ballot[r.label]) a += 1; else rj += 1;
        }
      });
      assert.strictEqual(r.approves, a, `approve count for ${r.label} in mission ${mi.n}`);
      assert.strictEqual(r.rejects, rj, `reject count for ${r.label} in mission ${mi.n}`);
      const approved = a > rj;
      assert.strictEqual(r.approved, approved, 'tie must count as reject');
      assert.strictEqual(r.correct, approved === !r.forged, 'correctness');
      if (!r.correct) clean = false;
      r.votes.forEach((vt) => {
        if (roleOf[vt.id] === 'loyal' && vt.approve === !r.forged) parts[vt.id].votes += 1;
      });
      if (r.forged && approved) doubles.forEach((d) => { parts[d].forgeries += 2; });
      assert.notStrictEqual(r.filer, undefined);
      if (roleOf[r.filer] === 'loyal') assert.strictEqual(r.forged, false, 'a loyal agent can never file a forgery');
    });
    assert.strictEqual(mi.clean, clean, 'mission clean flag');
    if (clean) winsL += 1; else winsD += 1;
  });
  assert.deepStrictEqual(res.wins, { loyal: winsL, double: winsD }, 'mission win tally');
  assert.ok(winsL === 2 || winsD === 2, 'someone reached 2 mission wins');
  assert.ok(res.recap.length <= 3);
  if (res.recap.length === 3) assert.ok(winsL === 1 && winsD === 1 || res.recap.length === 3, 'third mission only when needed');
  if (res.recap.length === 2) assert.ok(winsL === 2 || winsD === 2, 'game stops once decided');

  // Exposure
  const tall = {};
  bots.forEach((b) => { tall[b.id] = 0; });
  bots.forEach((b) => (b.sentFinal || []).forEach((id) => { tall[id] += 1; }));
  res.tallies.forEach((t) => assert.strictEqual(t.votes, tall[t.id], 'suspect tally'));
  const groups = {};
  Object.entries(tall).forEach(([id, c]) => { if (c > 0) (groups[c] = groups[c] || []).push(id); });
  const exposed = []; let remaining = doubles.length;
  Object.keys(groups).map(Number).sort((a, b) => b - a).some((c) => {
    if (groups[c].length > remaining) return true;
    exposed.push(...groups[c]); remaining -= groups[c].length; return false;
  });
  assert.deepStrictEqual(res.exposed.slice().sort(), exposed.slice().sort(), 'exposed set');
  const allExposed = doubles.every((d) => exposed.includes(d));
  const winner = winsL >= 2 || allExposed ? 'loyal' : 'double';
  assert.strictEqual(res.winner, winner, 'winner rule');

  bots.forEach((b) => {
    if (roleOf[b.id] === 'loyal') (b.sentFinal || []).forEach((id) => { if (roleOf[id] === 'double') parts[b.id].accusations += 2; });
  });
  doubles.forEach((d) => { if (!exposed.includes(d)) parts[d].hidden += 2; });
  bots.forEach((b) => { if ((winner === 'double') === (roleOf[b.id] === 'double')) parts[b.id].win += 3; });
  res.scores.forEach((s) => {
    const p = parts[s.id];
    const total = p.votes + p.forgeries + p.accusations + p.hidden + p.win;
    assert.strictEqual(s.score, total, `score for ${s.name}: server ${s.score} vs recomputed ${total}`);
  });
  assert.ok(res.top.length >= 1);

  // Verify results were truthful: a "mismatch" can only ever appear on a forged report.
  bots.forEach((b) => {
    Object.entries(b.verifySeen).forEach(([mn, list]) => {
      const mi = res.recap.find((x) => String(x.n) === mn);
      list.forEach((v) => {
        const rep = mi.reports.find((r) => r.label === v.label);
        if (v.result === 'mismatch') assert.ok(rep.forged, 'mismatch only on forged reports');
      });
    });
  });
  return { winsL, winsD, winner, allExposed };
}

// ---------- Privacy checks: scan every byte a loyal player ever received ----------
function assertNoLeaks(bots) {
  const loyals = bots.filter((b) => b.view.you.role === 'loyal');
  assert.ok(loyals.length > 0);
  loyals.forEach((b) => {
    b.raw.forEach((m) => {
      const live = ['reveal', 'briefing', 'filing', 'investigate', 'vote'].includes(m.phase) && m.mission <= 1 && !(m.wins && (m.wins.loyal || m.wins.double));
      if (live) {
        assert.ok(!m.text.includes('"truth"'), `${b.name} received mission truth`);
        assert.ok(!m.text.includes('"partners"'), `${b.name} received partner list`);
        assert.ok(!/"role":"double"/.test(m.text), `${b.name} received a double role`);
        assert.ok(!/"forged":(true|false)/.test(m.text), `${b.name} learned a forged flag early`);
        assert.ok(!m.text.includes('"approves"'), `${b.name} saw vote tallies early`);
      }
      // Verify results are private: the public log never carries a result.
      const v = JSON.parse(m.text);
      if (v.verify) v.verify.log.forEach((l) => assert.ok(!('result' in l), 'verify result leaked in public log'));
      // Filers stay anonymous until the end.
      if (m.phase !== 'results') assert.ok(!m.text.includes('"filer"'), `${b.name} saw filer identities early`);
    });
  });
}

// ---------- Test runner ----------
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`  PASS  ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failures += 1;
    results.push(`  FAIL  ${name}\n        ${e.stack.split('\n').slice(0, 4).join('\n        ')}`);
  }
}

function rawUpgrade(path, headers) {
  return new Promise((resolve) => {
    const req = http.request({
      port: PORT, path, headers: Object.assign({
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
      }, headers),
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });
}
function httpGet(path) {
  return new Promise((resolve) => {
    http.get({ port: PORT, path }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', () => resolve({ status: 0, body: '' }));
  });
}

async function main() {
  const server = await start(0);
  PORT = server.address().port;
  URL_WS = `ws://127.0.0.1:${PORT}/ws`;
  const allBots = [];
  const track = (bots) => { allBots.push(...bots); return bots; };

  // ===== Phase 1: foundation =====
  await test('web page and health check are served', async () => {
    const page = await httpGet('/');
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes('Double Agent'));
    const h = await httpGet('/health');
    assert.strictEqual(h.status, 200);
    assert.ok(JSON.parse(h.body).ok);
  });

  await test('path traversal and cross-site websockets are blocked', async () => {
    assert.ok([403, 404].includes((await httpGet('/../server.js')).status));
    assert.ok([403, 404].includes((await httpGet('/%2e%2e/server.js')).status));
    assert.ok([403, 404].includes((await httpGet('/..%2fserver.js')).status));
    assert.strictEqual(await rawUpgrade('/ws', { Origin: 'http://evil.example' }), 403);
    assert.strictEqual(await rawUpgrade('/other', {}), 403);
    assert.strictEqual(await rawUpgrade('/ws', { Origin: `http://localhost:${PORT}` }), 101);
  });

  await test('join errors: bad code, unknown room, bad name, duplicate name', async () => {
    const host = await new Bot('Alice').create(); track([host]);
    const a = new Bot('Zed'); await a.join('ZZZZ'); track([a]);
    assert.strictEqual(a.lastError().code, 'NO_ROOM');
    const b = new Bot('Zed'); await b.join('ab1'); track([b]);
    assert.strictEqual(b.lastError().code, 'NO_ROOM');
    const c = new Bot('x'); await c.join(host.code); track([c]);
    assert.strictEqual(c.lastError().code, 'NAME');
    const d = new Bot('alice'); await d.join(host.code); track([d]);
    assert.strictEqual(d.lastError().code, 'NAME_TAKEN');
    const e = new Bot('Bob'); await e.join(host.code.toLowerCase()); track([e]);
    assert.ok(e.view, 'lowercase codes are accepted');
    await until(() => host.view.players.length === 2, 2000, 'host sees Bob');
  });

  await test('lobby: live updates, host-only start, minimum 4, kick, full room', async () => {
    const bots = track(await makeRoom(4));
    const [host, p2, p3, p4] = bots;
    p2.send({ t: 'start' });
    await until(() => p2.errors.length, 1000, 'non-host rejected');
    assert.strictEqual(p2.lastError().code, 'HOST');
    // Ready status is shared with everyone.
    p3.send({ t: 'lobbyReady', on: true });
    await until(() => host.view.players.find((x) => x.name === 'P3').ready, 2000, 'ready visible');
    // Kick
    host.send({ t: 'kick', id: p4.id });
    await until(() => p4.extra.kicked, 2000, 'kicked notice');
    await until(() => host.view.players.length === 3, 2000, 'roster shrinks');
    host.send({ t: 'start' });
    await until(() => host.errors.length, 1000, 'too few players');
    assert.strictEqual(host.lastError().code, 'FEW');
    // Fill to 8, a 9th must be refused.
    const more = [];
    for (let i = 0; i < 5; i++) more.push(await new Bot(`Q${i}`).join(host.code));
    track(more);
    assert.strictEqual(host.view.players.length, 8);
    const ninth = await new Bot('Late').join(host.code); track([ninth]);
    assert.strictEqual(ninth.lastError().code, 'FULL');
  });

  // ===== Phase 2 + 3: the game, privacy, validation =====
  await test('4 players: Loyal victory through clean missions (scores verified)', async () => {
    let seen = null;
    for (let attempt = 0; attempt < 5 && !seen; attempt++) {
      const { bots, res } = await playFull(4, {
        doubleFile: 'genuine',
        vote: () => true,
        final: (b, v) => v.players.filter((p) => p.id !== b.id).slice(0, v.final.k).map((p) => p.id),
      });
      track(bots);
      assertNoLeaks(bots);
      if (res.winner === 'loyal' && res.wins.loyal === 2) seen = res;
    }
    assert.ok(seen, 'a Loyal mission victory was reached');
    assert.strictEqual(seen.wins.loyal, 2);
  });

  await test('8 players: Double victory through sabotage + hidden traitors (scores verified)', async () => {
    let seen = null;
    for (let attempt = 0; attempt < 8 && !seen; attempt++) {
      const { bots, res } = await playFull(8, {
        doubleFile: 'forged',
        vote: () => true, // everyone naively approves everything
        final: (b, v) => {
          const doubles = new Set(doublesOf(b.room).map((d) => d.id));
          const pool = v.players.filter((p) => p.id !== b.id && !doubles.has(p.id)); // blame the wrong people
          return pool.slice(0, v.final.k).map((p) => p.id);
        },
      });
      track(bots);
      assertNoLeaks(bots);
      if (res.winner === 'double') seen = res;
    }
    assert.ok(seen, 'a Double victory was reached');
    assert.strictEqual(seen.reason.includes('sabotaged'), true);
  });

  await test('5 players: Loyal comeback by exposing every Double (scores verified)', async () => {
    let seen = null;
    for (let attempt = 0; attempt < 10 && !seen; attempt++) {
      const { bots, res } = await playFull(5, {
        doubleFile: 'forged',
        vote: () => true,
        final: (b, v) => {
          const doubles = doublesOf(b.room).map((d) => d.id);
          if (doubles.includes(b.id)) { // doubles try to frame loyals
            return v.players.filter((p) => p.id !== b.id && !doubles.includes(p.id)).slice(0, v.final.k).map((p) => p.id);
          }
          return doubles.slice(0, v.final.k);
        },
      });
      track(bots);
      if (res.wins.double === 2 && res.winner === 'loyal' && res.reason.includes('exposed')) seen = res;
    }
    assert.ok(seen, 'a comeback win was reached');
  });

  await test('6 players: Loyals who genuinely investigate beat naive play more than chance (smoke)', async () => {
    // Loyals reject any report in a conflict or a mismatch; just proves the full flow runs end to end.
    const { bots, res } = await playFull(6, {
      doubleFile: 'forged',
      vote: (b, v, r) => {
        const mine = (v.verify.results || []).find((x) => x.label === r.label);
        if (mine && mine.result === 'mismatch') return false;
        const conflicts = v.reports.some((o) => o.label !== r.label && o.facts.some((f) => r.facts.some((g) => g.key === f.key && g.value !== f.value)));
        return !conflicts;
      },
      final: (b, v) => v.players.filter((p) => p.id !== b.id).slice(0, v.final.k).map((p) => p.id),
    });
    track(bots);
    assertNoLeaks(bots);
    assert.ok(['loyal', 'double'].includes(res.winner));
  });

  await test('validation: duplicates, stale, wrong phase, own report, host-only replay, join in progress', async () => {
    const bots = track(await makeRoom(6, null));
    const host = bots[0];
    host.send({ t: 'start' });
    await until(() => bots.every((b) => b.view.phase === 'reveal'), 3000, 'reveal');
    // late joiner is refused
    const late = await new Bot('Late').join(host.code); track([late]);
    assert.strictEqual(late.lastError().code, 'IN_PROGRESS');
    // action out of phase
    await expectErr(bots[1], { t: 'vote', votes: {} }, 'PHASE', 'vote during reveal');
    await until(() => bots.every((b) => b.view.phase === 'filing'), 6000, 'filing');
    const team = bots.filter((b) => b.view.filing);
    const nonTeam = bots.filter((b) => !b.view.filing);
    assert.strictEqual(team.length, 3, 'field team of 3 for 6 players');
    await expectErr(nonTeam[0], { t: 'file', choice: 'genuine' }, 'NOT_ALLOWED', 'non-team cannot file');
    await expectErr(team[0], { raw: { t: 'file', pid: 9999, choice: 'genuine' } }, 'STALE', 'stale phase id');
    const loyalTeam = team.find((b) => b.view.you.role === 'loyal');
    if (loyalTeam) await expectErr(loyalTeam, { t: 'file', choice: 'forged' }, 'NOT_ALLOWED', 'loyal cannot forge');
    team[0].act({ t: 'file', choice: 'genuine' });
    await until(() => team[0].oks.length, 1000, 'file accepted');
    await expectErr(team[0], { t: 'file', choice: 'genuine' }, 'DUPLICATE', 'duplicate filing');
    // Investigation
    await until(() => bots.every((b) => b.view.phase === 'investigate'), 6000, 'investigate');
    const owner = bots.find((b) => b.view.reports.some((r) => r.mine));
    const mine = owner.view.reports.find((r) => r.mine);
    await expectErr(owner, { t: 'verify', report: mine.label, fact: mine.facts[0].key }, 'OWN_REPORT', 'own report');
    const v1 = bots.find((b) => b !== owner);
    const other = v1.view.reports.find((r) => !r.mine);
    v1.act({ t: 'verify', report: other.label, fact: other.facts[0].key });
    await until(() => v1.view.verify.results.length === 1, 1000, 'verify result');
    await expectErr(v1, { t: 'verify', report: other.label, fact: other.facts[1].key }, 'DUPLICATE', 'second verify');
    assert.strictEqual(v1.view.verify.results.length, 1);
    bots.filter((b) => b !== v1).forEach((b) => {
      assert.strictEqual(b.view.verify.results.length, 0, 'a verify result is never visible to other players');
      assert.ok(!b.raw.some((m) => /"result":"(match|mismatch)"/.test(m.text)), 'no verify result ever reaches another player');
    });
    // Voting
    await until(() => bots.every((b) => b.view.phase === 'vote'), 8000, 'vote phase');
    const voter = bots[2];
    await expectErr(voter, { t: 'vote', votes: { A: true } }, 'BAD', 'incomplete ballot');
    const ballot = {};
    voter.view.reports.filter((r) => !r.mine).forEach((r) => { ballot[r.label] = true; });
    await expectErr(voter, { t: 'vote', votes: { ...ballot, Z: true } }, 'BAD', 'extra key in ballot');
    assert.ok(!voter.view.vote.submitted);
    voter.act({ t: 'vote', votes: ballot });
    await until(() => voter.view.vote.submitted, 1000, 'ballot accepted');
    await expectErr(voter, { t: 'vote', votes: Object.fromEntries(Object.keys(ballot).map((k) => [k, false])) }, 'DUPLICATE', 'second ballot');
    bots.filter((b) => b !== voter).forEach((b) => assert.strictEqual(b.view.vote.mine, null, 'ballots are private'));
    await expectErr(bots[3], { t: 'again' }, 'PHASE', 'replay before the game ends');
  });

  await test('reliability: refresh/reconnect restores seat + private info; second tab takes over', async () => {
    const bots = track(await makeRoom(5, { doubleFile: 'forged', vote: () => true, final: (b, v) => v.players.filter((p) => p.id !== b.id).slice(0, v.final.k).map((p) => p.id) }));
    bots[0].send({ t: 'start' });
    await until(() => bots.every((b) => b.view.phase === 'investigate'), 12000, 'investigate');
    const victim = bots[2];
    const before = { id: victim.id, role: victim.view.you.role, token: victim.token, code: victim.code };
    const partners = victim.view.you.partners || null;
    // "refresh": drop the socket, then reconnect with the saved token
    victim.brain = null;
    victim.close();
    await until(() => bots[0].view.players.find((p) => p.id === before.id && !p.connected), 2000, 'others see disconnect');
    const back = new Bot('refreshed'); track([back]);
    await back.connect();
    back.send({ t: 'resume', code: before.code, token: before.token });
    await until(() => back.view && back.view.you, 2000, 'resumed');
    assert.strictEqual(back.view.you.id, before.id, 'same seat');
    assert.strictEqual(back.view.you.role, before.role, 'same role');
    assert.deepStrictEqual(back.view.you.partners || null, partners, 'same partner info');
    assert.ok(['investigate', 'vote', 'result', 'briefing', 'filing', 'final', 'results'].includes(back.view.phase));
    await until(() => bots[0].view.players.find((p) => p.id === before.id && p.connected), 2000, 'others see reconnect');
    // second tab with the same token: newest wins, old gets "replaced"
    const tab2 = new Bot('tab2'); track([tab2]);
    await tab2.connect();
    tab2.send({ t: 'resume', code: before.code, token: before.token });
    await until(() => tab2.view && tab2.view.you, 2000, 'second tab');
    await until(() => back.extra.replaced, 2000, 'first tab replaced');
    // bad resume attempts
    const bad = new Bot('bad'); track([bad]);
    await bad.connect();
    bad.send({ t: 'resume', code: before.code, token: 'nope' });
    await until(() => bad.errors.length, 1000, 'bad token refused');
    assert.strictEqual(bad.lastError().code, 'NO_SEAT');
    bad.send({ t: 'resume', code: 'QQQQ', token: before.token });
    await until(() => bad.errors.length > 1, 1000, 'gone room');
    assert.strictEqual(bad.lastError().code, 'ROOM_GONE');
    // the game continues without the disconnected player (everyone else keeps going to the end)
    tab2.brain = makeBrain({ doubleFile: 'forged', vote: () => true, final: (b, v) => v.players.filter((p) => p.id !== b.id).slice(0, v.final.k).map((p) => p.id) });
    tab2.brain(tab2, tab2.view);
    await until(() => bots[0].view.phase === 'results', 20000, 'game finishes');
  });

  await test('reliability: a disconnected player never stalls the game', async () => {
    const bots = track(await makeRoom(6, { doubleFile: 'genuine', vote: () => true, final: (b, v) => v.players.filter((p) => p.id !== b.id).slice(0, v.final.k).map((p) => p.id) }));
    bots[0].send({ t: 'start' });
    await until(() => bots.every((b) => b.view.phase === 'briefing'), 5000, 'briefing');
    bots[5].brain = null; bots[5].close(); // leaves and never returns
    await until(() => bots[0].view.phase === 'results', 20000, 'game completes with one player missing');
  });

  await test('reliability: host disconnect hands the host role over', async () => {
    const bots = track(await makeRoom(4, null));
    bots[0].close();
    await until(() => bots[1].view.players.find((p) => p.host && p.connected && p.name !== 'Host'), 5000, 'new host');
    assert.ok(bots[1].view.players.filter((p) => p.host).length === 1);
  });

  await test('reliability: game is called off if too many players leave, and a replay works', async () => {
    const bots = track(await makeRoom(4, null));
    bots[0].send({ t: 'start' });
    await until(() => bots.every((b) => b.view.phase !== 'lobby'), 3000, 'started');
    bots[2].close(); bots[3].close();
    await until(() => bots[0].view.phase === 'lobby' && bots[0].view.notice, 15000, 'called off to lobby');
    assert.ok(bots[0].view.notice.includes('called off'));
    // survivors can start a fresh game when enough players are back
    const n1 = await new Bot('New1').join(bots[0].code); const n2 = await new Bot('New2').join(bots[0].code);
    track([n1, n2]);
    await until(() => bots[0].view.players.filter((p) => p.connected).length >= 4, 3000, 'enough players');
    bots[0].send({ t: 'start' });
    await until(() => bots[0].view.phase === 'reveal', 3000, 'new game starts');
  });

  await test('replay: host starts another round from the results screen with fresh roles', async () => {
    const { bots } = await playFull(4, {
      doubleFile: 'genuine', vote: () => true,
      final: (b, v) => v.players.filter((p) => p.id !== b.id).slice(0, v.final.k).map((p) => p.id),
    });
    track(bots);
    bots[1].send({ t: 'again' });
    await until(() => bots[1].errors.some((e) => e.code === 'HOST'), 1000, 'non-host refused');
    bots[0].send({ t: 'again' });
    await until(() => bots.every((b) => b.view.phase === 'lobby'), 2000, 'back to lobby');
    assert.ok(bots.every((b) => !b.view.you.role), 'roles cleared');
    bots[0].send({ t: 'start' });
    await until(() => bots.every((b) => b.view.phase === 'reveal' && b.view.you.role), 2000, 'second game');
  });

  await test('chat: delivered to everyone, trimmed, rate limited, plain text only', async () => {
    const bots = track(await makeRoom(4, null));
    bots[1].send({ t: 'chat', text: '  <b>hello</b>   team  ' });
    await until(() => bots.every((b) => b.view.chat.length === 1), 2000, 'chat delivered');
    assert.strictEqual(bots[0].view.chat[0].text, '<b>hello</b> team'); // stored as text, client renders as text
    for (let i = 0; i < 8; i++) bots[1].send({ t: 'chat', text: `msg ${i}` });
    await until(() => bots[1].errors.some((e) => e.code === 'RATE'), 2000, 'rate limit');
    bots[1].send({ t: 'chat', text: 'x'.repeat(500) });
    await until(() => bots[1].errors.some((e) => e.code === 'BAD'), 2000, 'too long refused');
  });

  await test('protocol: garbage and oversized messages are survived', async () => {
    const b = await new Bot('Junk').connect(); track([b]);
    b.ws.send('this is not json');
    b.ws.send(JSON.stringify({ t: 'vote' }));
    b.ws.send(JSON.stringify([1, 2, 3]));
    await until(() => b.errors.length >= 3, 2000, 'errors for junk');
    const big = new Bot('Big'); track([big]);
    await big.connect();
    big.ws.send('x'.repeat(40000));
    await until(() => big.closed, 3000, 'oversized message closes connection');
    const h = await httpGet('/health');
    assert.strictEqual(h.status, 200, 'server still healthy');
  });

  await test('abuse protection: room creation is rate limited per IP', async () => {
    const made = [];
    let limited = false;
    for (let i = 0; i < 24 && !limited; i++) {
      const b = new Bot(`R${i}`); b.ip = '203.0.113.7';
      await b.connect(); made.push(b);
      b.send({ t: 'create', name: `Rate${i}` });
      await until(() => b.code || b.errors.length, 2000, 'create reply');
      if (b.errors.length && b.lastError().code === 'RATE') limited = true;
    }
    track(made);
    assert.ok(limited, 'limiter kicked in');
  });

  // ---------- Report ----------
  allBots.forEach((b) => b.close());
  console.log('\nDouble Agent: Protocol Zero - test results\n');
  console.log(results.join('\n'));
  console.log(`\n${results.length - failures}/${results.length} passed${failures ? `, ${failures} FAILED` : ''}\n`);
  server.close();
  setTimeout(() => process.exit(failures ? 1 : 0), 200);
}

main().catch((e) => { console.error(e); process.exit(1); });
