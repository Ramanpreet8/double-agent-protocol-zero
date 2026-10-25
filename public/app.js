/* Double Agent: Protocol Zero - browser client.
 * The browser only DISPLAYS what the server sends and SENDS requests.
 * It never decides roles, votes, scores or winners.
 * All text from other players is inserted as plain text (never as HTML). */
(() => {
  'use strict';

  const $app = document.getElementById('app');

  // ---------- Storage (safe even if the browser blocks it) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  function loadSession() {
    try { return JSON.parse(store.get('dapz-session') || 'null'); } catch (e) { return null; }
  }

  // ---------- State ----------
  const S = {
    view: null, ws: null, conn: 'connecting', replaced: false, resuming: false,
    homeMsg: null, toast: null, offset: 0, attempts: 0, sig: '', retry: null, toastTimer: null,
  };
  const ui = {
    name: store.get('dapz-name') || '',
    code: (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4),
    helpOpen: false, helpIdx: 0, roleOpen: false, reveal: false,
    chat: '', verifyPending: null, ballot: {}, suspects: new Set(), showTruth: false, stamped: {},
  };

  // ---------- Tiny DOM helper ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'vars') Object.entries(v).forEach(([n, val]) => el.style.setProperty(n, val));
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    kids.flat(Infinity).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return el;
  }

  const plural = (n, one, many) => (n === 1 ? one : many);
  const nameOf = (v, id) => (v.players.find((p) => p.id === id) || { name: 'Someone' }).name;

  // ---------- Networking ----------
  function send(obj) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
  }
  function act(obj) { send({ ...obj, pid: S.view ? S.view.pid : 0 }); }

  function connect() {
    clearTimeout(S.retry);
    if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
    S.conn = 'connecting';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      S.conn = 'open';
      S.attempts = 0;
      const sess = loadSession();
      if (sess && sess.code && sess.token) {
        S.resuming = true;
        send({ t: 'resume', code: sess.code, token: sess.token });
      }
      render();
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      onMessage(m);
    };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      S.conn = 'closed';
      if (!S.replaced) {
        S.attempts += 1;
        S.retry = setTimeout(connect, Math.min(5000, 700 * S.attempts));
      }
      render();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  function leaveToHome(msg, kind) {
    store.del('dapz-session');
    S.view = null;
    S.resuming = false;
    S.sig = '';
    ui.ballot = {}; ui.suspects = new Set(); ui.stamped = {};
    S.homeMsg = msg ? { text: msg, kind: kind || 'err' } : null;
    render();
  }

  const PHASE_TOASTS = {
    filing: 'Field agents are filing reports.',
    investigate: 'The reports are in. Time to investigate.',
    vote: 'Voting is open.',
    result: 'Votes counted.',
    final: 'Name your suspects.',
  };

  function onMessage(m) {
    switch (m.t) {
      case 'joined':
        store.set('dapz-session', JSON.stringify({ code: m.code, token: m.token }));
        break;
      case 'state': {
        const prev = S.view;
        S.resuming = false;
        S.homeMsg = null;
        S.view = m;
        S.offset = m.serverNow - Date.now();
        if (prev && prev.phase !== m.phase) {
          ui.verifyPending = null;
          ui.reveal = false;
          if (m.phase !== 'vote') ui.ballot = {};
          if (m.phase !== 'final') ui.suspects = new Set();
          if (m.phase === 'lobby') ui.stamped = {};
          if (PHASE_TOASTS[m.phase]) showToast(PHASE_TOASTS[m.phase], 'ok', true);
        }
        document.title = `Room ${m.code} - Double Agent`;
        // If only chat changed and the player is typing, patch the chat list and leave the rest alone.
        const sig = JSON.stringify({ ...m, chat: null, serverNow: null });
        const typing = document.activeElement && document.activeElement.id === 'chatin';
        if (sig === S.sig && typing) { renderChatList(); return; }
        S.sig = sig;
        render();
        break;
      }
      case 'ok':
        showToast(m.text, 'ok');
        break;
      case 'error':
        handleError(m);
        break;
      case 'kicked':
        leaveToHome('The host removed you from the room.');
        break;
      case 'left':
        leaveToHome(null);
        break;
      case 'replaced':
        S.replaced = true;
        render();
        break;
      default: break;
    }
  }

  function handleError(m) {
    if (S.resuming && (m.code === 'ROOM_GONE' || m.code === 'NO_SEAT')) {
      leaveToHome(m.text);
      return;
    }
    if (!S.view) {
      S.homeMsg = { text: m.text, kind: 'err' };
      render();
      return;
    }
    if (m.code === 'STALE') return; // the screen already moved on; nothing to tell the player
    showToast(m.text, 'err');
  }

  function showToast(text, kind, quiet) {
    clearTimeout(S.toastTimer);
    S.toast = { text, kind };
    if (!quiet) render(); else renderToastOnly();
    S.toastTimer = setTimeout(() => { S.toast = null; renderToastOnly(); }, 3200);
  }
  function renderToastOnly() {
    const old = document.getElementById('toastwrap');
    if (!old) { render(); return; }
    old.replaceWith(toastNode());
  }
  function toastNode() {
    return h('div', { class: 'toast-wrap', id: 'toastwrap' },
      S.toast ? h('div', { class: `toast ${S.toast.kind === 'err' ? 'err' : ''}`, role: 'status' }, S.toast.text) : null);
  }

  // ---------- Rendering ----------
  function render() {
    if (S.holding) { S.dirty = true; return; } // never swap the DOM out from under a finger holding the role card
    const active = document.activeElement;
    const focusId = active && active.id;
    const sel = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    $app.replaceChildren(buildRoot());
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (sel && el.setSelectionRange) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* ignore */ } }
      }
    }
    renderChatList();
    tickTimer();
  }

  function buildRoot() {
    const root = h('div', { class: 'shell' });
    if (S.conn !== 'open' && !S.replaced) {
      root.append(h('div', { class: 'conn', role: 'status' },
        S.conn === 'connecting' ? 'Connecting to the server...' : 'Connection lost. Trying to reconnect...'));
    }
    const tidy = (list) => list.flat(Infinity).filter(Boolean);
    if (S.replaced) {
      root.append(...tidy(screenReplaced()));
    } else if (S.resuming && !S.view) {
      root.append(h('div', { class: 'hero' }, h('h2', {}, 'Rejoining your game...')));
    } else if (!S.view) {
      root.append(...tidy(screenHome()));
    } else {
      root.append(...tidy(screenGame(S.view)));
    }
    root.append(toastNode());
    if (ui.helpOpen) root.append(helpModal());
    if (ui.roleOpen && S.view && S.view.you.role) root.append(roleModal(S.view));
    return root;
  }

  // ---------- Timer ----------
  function tickTimer() {
    const v = S.view;
    const el = document.getElementById('timer');
    const bar = document.getElementById('bar');
    if (!v || !el) return;
    if (!v.phaseEnds) {
      el.textContent = '';
      if (bar) bar.style.transform = 'scaleX(0)';
      return;
    }
    const left = Math.max(0, v.phaseEnds - (Date.now() + S.offset));
    const secs = Math.ceil(left / 1000);
    el.textContent = String(secs);
    el.classList.toggle('low', secs <= 5);
    if (bar && v.phaseMs) bar.style.transform = `scaleX(${Math.min(1, left / v.phaseMs)})`;
  }
  setInterval(tickTimer, 250);

  // ---------- Shared components ----------
  const banner = (text, warn) => h('div', { class: `banner ${warn ? 'warn' : ''}` }, text);

  const PHASE_LABEL = {
    lobby: 'Lobby', reveal: 'Your secret role', briefing: 'Mission briefing', filing: 'Filing reports',
    investigate: 'Investigate', vote: 'Vote on the reports', result: 'Result', final: 'Exposure vote', results: 'Debrief',
  };

  const SHORT_LABEL = {
    lobby: 'Lobby', reveal: 'Your role', briefing: 'Briefing', filing: 'Filing', investigate: 'Investigate',
    vote: 'Vote', result: 'Result', final: 'Exposure vote', results: 'Debrief',
  };

  function header(v) {
    const inGame = v.phase !== 'lobby';
    const sub = inGame && v.game && !['results', 'reveal', 'final'].includes(v.phase)
      ? `Mission ${v.game.missionNo}: ${SHORT_LABEL[v.phase]}` : SHORT_LABEL[v.phase];
    return h('header', { class: 'bar' },
      h('div', {},
        h('div', { class: 'bar-title' }, `Room ${v.code}`),
        h('div', { class: 'bar-sub' }, sub)),
      h('div', { class: 'bar-right' },
        h('span', { class: 'timer', id: 'timer', 'aria-label': 'Seconds left' }),
        v.you.role ? h('button', { class: 'icon-btn', onclick: () => { ui.roleOpen = true; render(); } }, 'My role') : null,
        h('button', { class: 'icon-btn', 'aria-label': 'How to play', onclick: () => { ui.helpOpen = true; ui.helpIdx = 0; render(); } }, '?')),
      h('div', { class: 'meter' }, h('div', { class: 'meter-fill', id: 'bar' })));
  }

  function missionTally(v) {
    return h('div', { class: 'tally' },
      h('div', {}, h('b', {}, v.game.wins.loyal), 'Loyal missions won'),
      h('div', {}, h('b', {}, v.game.wins.double), 'Double missions won'));
  }

  let lastPointerAt = 0;
  let autoHide = null;
  function setReveal(on) {
    ui.reveal = on;
    clearTimeout(autoHide);
    document.querySelectorAll('.rolecard').forEach((c) => c.classList.toggle('shown', on));
    if (!on && !S.holding && S.dirty) { S.dirty = false; render(); }
  }
  function release() { S.holding = false; if (ui.reveal) setReveal(false); else if (S.dirty) { S.dirty = false; render(); } }
  window.addEventListener('pointerup', release);
  window.addEventListener('blur', release);

  function keyboardToggle() {
    setReveal(!ui.reveal);
    // A role revealed without holding hides itself again, so it never stays on screen by accident.
    if (ui.reveal) autoHide = setTimeout(() => setReveal(false), 6000);
  }

  function roleCard(v) {
    const isD = v.you.role === 'double';
    const partners = v.you.partners || [];
    return h('div', null,
      h('div', { class: `rolecard ${v.you.role}${ui.reveal ? ' shown' : ''}` },
        h('div', { class: 'cover' }, h('strong', {}, 'Your role is hidden'), h('span', { class: 'muted small' }, 'Hold the button below to look. Keep your screen private.')),
        h('div', { class: 'secret' },
          h('div', { class: 'rolename' }, isD ? 'Double agent' : 'Loyal agent'),
          isD
            ? [h('p', {}, 'You work for the enemy and you know the real facts of every mission. Sneak a forged report past the team and stay hidden.'),
              h('p', {}, partners.length
                ? `Your ${plural(partners.length, 'partner is', 'partners are')}: ${partners.map((p) => p.name).join(', ')}.`
                : 'You are the only Double Agent.')]
            : h('p', {}, 'Find the forged reports. Approve the true ones, reject the fakes, and expose the Doubles.'),
          h('p', { class: 'muted small' }, `This game has ${v.game.doublesCount} Double ${plural(v.game.doublesCount, 'Agent', 'Agents')}.`))),
      h('button', {
        class: 'btn btn-wide holdbtn', id: 'holdbtn',
        onpointerdown: (e) => { e.preventDefault(); lastPointerAt = Date.now(); S.holding = true; setReveal(true); },
        onpointerup: release,
        onpointerleave: release,
        onpointercancel: release,
        oncontextmenu: (e) => e.preventDefault(),
        // Keyboard and screen-reader users cannot "hold", so for them the button toggles.
        onkeydown: (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); lastPointerAt = Date.now(); keyboardToggle(); }
        },
        onclick: (e) => { if (Date.now() - lastPointerAt > 800 && !e.pointerType) keyboardToggle(); },
      }, 'Hold to reveal'));
  }

  function roleModal(v) {
    return h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) { ui.roleOpen = false; setReveal(false); render(); } } },
      h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Your role' },
        h('h2', {}, 'Your role'),
        roleCard(v),
        h('button', { class: 'btn btn-wide btn-ghost', style: 'margin-top:12px', onclick: () => { ui.roleOpen = false; setReveal(false); render(); } }, 'Close')));
  }

  const HELP = [
    ['Two sides', ['Most players are Loyal Agents. A few are Double Agents working for the enemy.', 'Doubles know each other. Loyals do not know anyone. Everyone knows how many Doubles there are.']],
    ['Field reports', ['Each mission, a few players file an anonymous report about the target. Every report states two facts.', 'Loyal reports are always true. A Double can file a forgery with one fact changed.']],
    ['Investigate', ['Compare the reports. If two reports disagree about the same fact, at least one is fake.', 'Once per mission you can Verify one fact on someone else\'s report. The game tells only you if it matches. You can tell the team what you found, but you are allowed to lie.']],
    ['Vote', ['Approve or reject every report except your own.', 'A mission is a Clean Call only if every true report is approved and every forgery is rejected. Any mistake gives the point to the Doubles. First side to win 2 missions wins.']],
    ['Exposure vote', ['After the missions, everyone names their suspects.', 'If the Doubles won the missions but every one of them is exposed, the Loyals still win. Doubles win by sabotaging missions and staying hidden.']],
  ];
  function helpModal() {
    const i = ui.helpIdx;
    const [title, paras] = HELP[i];
    return h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) { ui.helpOpen = false; render(); } } },
      h('div', { class: 'modal', role: 'dialog', 'aria-label': 'How to play' },
        h('h2', {}, title),
        paras.map((p) => h('p', {}, p)),
        h('div', { class: 'dots' }, HELP.map((_, k) => h('i', { class: k === i ? 'on' : '' }))),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-ghost grow', disabled: i === 0, onclick: () => { ui.helpIdx -= 1; render(); } }, 'Back'),
          i < HELP.length - 1
            ? h('button', { class: 'btn btn-primary grow', onclick: () => { ui.helpIdx += 1; render(); } }, 'Next')
            : h('button', { class: 'btn btn-primary grow', onclick: () => { ui.helpOpen = false; render(); } }, 'Got it'))));
  }

  // ---------- Home ----------
  function screenHome() {
    const ready = S.conn === 'open';
    const create = () => {
      ui.name = ui.name.trim();
      if (Array.from(ui.name).length < 2) { S.homeMsg = { text: 'Pick a name between 2 and 14 characters.', kind: 'err' }; render(); return; }
      store.set('dapz-name', ui.name);
      send({ t: 'create', name: ui.name });
    };
    const join = () => {
      ui.name = ui.name.trim();
      if (Array.from(ui.name).length < 2) { S.homeMsg = { text: 'Pick a name between 2 and 14 characters.', kind: 'err' }; render(); return; }
      if (ui.code.length !== 4) { S.homeMsg = { text: 'Room codes have 4 letters.', kind: 'err' }; render(); return; }
      store.set('dapz-name', ui.name);
      send({ t: 'join', code: ui.code, name: ui.name });
    };
    return [
      h('div', { class: 'hero' },
        h('h1', {}, 'Double Agent'),
        h('div', { class: 'sub' }, 'Protocol Zero'),
        h('p', {}, 'Some of the intelligence is forged. So are some of your teammates. Work out who to trust before the mission fails.')),
      S.homeMsg ? banner(S.homeMsg.text, S.homeMsg.kind === 'err') : null,
      h('label', { class: 'field' }, h('span', {}, 'Your codename'),
        h('input', { type: 'text', id: 'name', maxlength: '14', autocomplete: 'off', value: ui.name, placeholder: 'Agent name', oninput: (e) => { ui.name = e.target.value; } })),
      h('button', { class: 'btn btn-primary btn-wide', style: 'margin-top:14px', disabled: !ready, onclick: create }, 'Create a room'),
      h('div', { class: 'or' }, 'or join friends'),
      h('label', { class: 'field' }, h('span', {}, 'Room code'),
        h('input', {
          type: 'text', id: 'code', class: 'code', maxlength: '4', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', value: ui.code, placeholder: 'ABCD',
          oninput: (e) => { ui.code = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); e.target.value = ui.code; },
          onkeydown: (e) => { if (e.key === 'Enter') join(); },
        })),
      h('button', { class: 'btn btn-wide', style: 'margin-top:12px', disabled: !ready, onclick: join }, 'Join room'),
      h('button', { class: 'btn btn-wide btn-ghost', style: 'margin-top:12px', onclick: () => { ui.helpOpen = true; ui.helpIdx = 0; render(); } }, 'How to play'),
      h('p', { class: 'muted small', style: 'margin-top:20px' }, '4 to 8 players. About 10 minutes. No accounts, nothing to install.'),
    ];
  }

  function screenReplaced() {
    return [
      h('div', { class: 'hero' }, h('h2', {}, 'Open in another tab')),
      banner('This game is now open in another tab or window, and that one has taken over your seat.'),
      h('button', { class: 'btn btn-primary btn-wide', onclick: () => { S.replaced = false; S.conn = 'closed'; connect(); render(); } }, 'Play in this tab instead'),
    ];
  }

  // ---------- Game router ----------
  function screenGame(v) {
    const out = [header(v)];
    if (v.notice && v.phase === 'lobby') out.push(banner(v.notice, true));
    switch (v.phase) {
      case 'lobby': out.push(...screenLobby(v)); break;
      case 'reveal': out.push(...screenReveal(v)); break;
      case 'briefing': out.push(...screenBriefing(v)); break;
      case 'filing': out.push(...screenFiling(v)); break;
      case 'investigate': out.push(...screenInvestigate(v)); break;
      case 'vote': out.push(...screenVote(v)); break;
      case 'result': out.push(...screenResult(v)); break;
      case 'final': out.push(...screenFinal(v)); break;
      case 'results': out.push(...screenResults(v)); break;
      default: out.push(banner('Waiting for the server...'));
    }
    return out;
  }

  // ---------- Lobby ----------
  function screenLobby(v) {
    const connected = v.players.filter((p) => p.connected).length;
    const isHost = v.you.host;
    const readyCount = v.players.filter((p) => p.connected && p.ready).length;
    const doubles = { 4: 1, 5: 2, 6: 2, 7: 3, 8: 3 }[Math.min(8, Math.max(4, connected))];
    const link = `${location.origin}/?room=${v.code}`;
    const share = async () => {
      const data = { title: 'Double Agent: Protocol Zero', text: `Join my game. Room code ${v.code}`, url: link };
      try {
        if (navigator.share) { await navigator.share(data); return; }
        await navigator.clipboard.writeText(link);
        showToast('Invite link copied.', 'ok');
      } catch (e) { showToast(`Share this code: ${v.code}`, 'ok'); }
    };
    return [
      h('div', { class: 'codebox' },
        h('div', { class: 'muted small' }, 'Room code. Friends type it in or open the invite link.'),
        h('div', { class: 'code', 'aria-label': `Room code ${v.code.split('').join(' ')}` }, v.code),
        h('button', { class: 'btn btn-small', style: 'margin-top:10px', onclick: share }, 'Share invite')),
      h('div', { class: 'panel' },
        h('div', { class: 'row spread' }, h('strong', {}, `Players (${v.players.length} of ${v.limits.max})`),
          h('span', { class: 'muted small' }, `${readyCount} ready`)),
        h('ul', { class: 'players' }, v.players.map((p) => h('li', {},
          h('span', { class: 'pname' }, p.name, p.id === v.you.id ? ' (you)' : ''),
          p.host ? h('span', { class: 'tag host' }, 'Host') : null,
          !p.connected ? h('span', { class: 'tag away' }, 'Away') : null,
          p.ready ? h('span', { class: 'tag on' }, 'Ready') : null,
          isHost && p.id !== v.you.id
            ? h('button', { class: 'btn btn-small btn-danger', 'aria-label': `Remove ${p.name}`, onclick: () => send({ t: 'kick', id: p.id }) }, 'Remove') : null)))),
      h('button', { class: 'btn btn-wide', style: 'margin-top:14px', onclick: () => send({ t: 'lobbyReady', on: !v.you.ready }) },
        v.you.ready ? 'Not ready' : 'I am ready'),
      isHost
        ? h('div', { class: 'stack', style: 'margin-top:12px' },
          h('button', { class: 'btn btn-primary btn-wide', disabled: connected < v.limits.min, onclick: () => send({ t: 'start' }) }, 'Start game'),
          h('p', { class: 'muted small' }, connected < v.limits.min
            ? `You need at least ${v.limits.min} players connected. ${connected} so far.`
            : `${connected} players, ${doubles} Double ${plural(doubles, 'Agent', 'Agents')}. Players who are away will be left out.`))
        : banner('Waiting for the host to start the game.'),
      chatPanel(v),
      h('button', { class: 'btn btn-wide btn-ghost', style: 'margin-top:18px', onclick: () => send({ t: 'leave' }) }, 'Leave room'),
    ];
  }

  // ---------- Reveal ----------
  function screenReveal(v) {
    return [
      banner('Hold the card to see your secret role. Keep your screen private.'),
      roleCard(v),
      h('p', { class: 'muted small' }, 'You can look again any time with the My role button.'),
    ];
  }

  // ---------- Mission pieces ----------
  function intelPanel(v) {
    if (!v.mission || !v.mission.truth) return null;
    return h('div', { class: 'intel' },
      h('h3', {}, 'Real facts, for Doubles only'),
      h('button', { class: 'btn btn-small', onclick: () => { ui.showTruth = !ui.showTruth; render(); } }, ui.showTruth ? 'Hide' : 'Show'),
      ui.showTruth
        ? h('dl', {}, v.mission.truth.map((f) => [h('dt', {}, f.label), h('dd', {}, f.value)]))
        : h('p', { class: 'muted small' }, 'Hidden so nobody can peek over your shoulder.'));
  }

  function screenBriefing(v) {
    const m = v.mission;
    return [
      banner('Read the mission. The field team files reports next.'),
      h('h2', {}, m.title),
      h('p', {}, m.story),
      h('h3', {}, 'What the reports will cover'),
      h('div', { class: 'chips' }, m.labels.map((l) => h('span', { class: 'chip' }, l.label))),
      h('h3', {}, 'Field team'),
      h('div', { class: 'chips' }, m.team.map((t) => h('span', { class: 'chip' }, t.name))),
      h('p', { class: 'muted small' }, 'Each member files one anonymous report with two facts.'),
      missionTally(v),
      intelPanel(v),
    ];
  }

  function factDiff(a, b) {
    return new Set(a.facts.filter((f, i) => f.value !== b.facts[i].value).map((f) => f.key));
  }

  function screenFiling(v) {
    const m = v.mission;
    const f = v.filing;
    const out = [];
    if (!f) {
      out.push(banner('The field team is filing reports. They appear anonymously when the clock ends.'));
      out.push(h('h3', {}, 'Field team'), h('div', { class: 'chips' }, m.team.map((t) => h('span', { class: 'chip' }, t.name))));
    } else if (!f.forged) {
      out.push(banner('You are on the field team. Your report is filed automatically and its facts are true.'));
      out.push(paperFromFacts('Your report', f.genuine));
    } else {
      const diff = factDiff({ facts: f.genuine }, { facts: f.forged });
      out.push(banner(f.choice ? 'Report filed. Wait for the clock to run out.' : 'You are on the field team. Choose which version to file.'));
      const choose = (c) => act({ t: 'file', choice: c });
      out.push(paperFromFacts('Genuine version', f.genuine, null,
        f.choice ? null : h('button', { class: 'btn btn-wide', onclick: () => choose('genuine') }, 'File the genuine report'),
        f.choice === 'genuine' ? 'You filed this one.' : null));
      out.push(paperFromFacts('Forged version', f.forged, diff,
        f.choice ? null : h('button', { class: 'btn btn-primary btn-wide', onclick: () => choose('forged') }, 'File the forged report'),
        f.choice === 'forged' ? 'You filed this one.' : 'The wavy underline shows the altered fact.'));
    }
    out.push(intelPanel(v));
    return out;
  }

  function paperFromFacts(title, facts, altered, action, note) {
    return h('article', { class: 'paper' },
      h('div', { class: 'tab' }, title),
      note ? h('p', { class: 'note' }, note) : null,
      h('dl', { class: 'facts' }, facts.map((f) => h('div', { class: `fact ${altered && altered.has(f.key) ? 'altered' : ''}` },
        h('dt', {}, f.label), h('dd', {}, f.value)))),
      action ? h('div', { style: 'margin-top:8px' }, action) : null);
  }

  function reportCard(v, r, o) {
    const res = o.res || new Map();
    const animate = o.mode === 'result' && o.animate;
    const card = h('article', { class: `paper ${r.mine ? 'mine' : ''} ${animate ? 'animate' : ''} ${o.mode === 'result' ? 'stamped' : ''}` },
      h('div', { class: 'tab' }, `Report ${r.label}`),
      r.mine ? h('p', { class: 'note' }, `You filed this report (the ${r.youFiled} version). You cannot verify it or vote on it.`) : null,
      h('dl', { class: 'facts' }, r.facts.map((f) => {
        const mark = res.get(`${r.label}:${f.key}`);
        let control = null;
        if (mark) {
          control = h('span', { class: `badge ${mark}` }, mark === 'match' ? 'Verified: matches' : 'Verified: does not match');
        } else if (o.canVerify && !r.mine) {
          const pend = ui.verifyPending && ui.verifyPending.label === r.label && ui.verifyPending.key === f.key;
          control = pend
            ? h('span', { class: 'row' },
              h('button', { class: 'btn btn-small btn-primary', onclick: () => { ui.verifyPending = null; act({ t: 'verify', report: r.label, fact: f.key }); } }, 'Use my Verify'),
              h('button', { class: 'btn btn-small', onclick: () => { ui.verifyPending = null; render(); } }, 'Cancel'))
            : h('button', { class: 'btn btn-small', onclick: () => { ui.verifyPending = { label: r.label, key: f.key }; render(); } }, 'Verify');
        }
        return h('div', { class: 'fact' }, h('dt', {}, f.label), h('dd', {}, f.value), control);
      })),
      o.extra ? o.extra : null);
    if (o.mode === 'result') {
      card.append(
        h('div', { class: 'stamps' },
          h('div', { class: `stamp ${r.forged ? 'forged' : 'genuine'}`, vars: { '--d': `${o.index * 0.55}s` } }, r.forged ? 'FORGED' : 'GENUINE'),
          h('div', { class: 'stamp vote', vars: { '--d': `${o.index * 0.55 + 0.3}s` } }, r.approved ? 'APPROVED' : 'REJECTED')));
    }
    return card;
  }

  function conflictsPanel(reports) {
    const by = {};
    reports.forEach((r) => r.facts.forEach((f) => {
      (by[f.key] = by[f.key] || { label: f.label, items: [] }).items.push({ report: r.label, value: f.value });
    }));
    const clashes = Object.values(by).filter((k) => k.items.length > 1 && new Set(k.items.map((i) => i.value)).size > 1);
    return h('div', { class: 'section' },
      h('h3', {}, 'Cross-check'),
      clashes.length
        ? clashes.map((k) => h('div', { class: 'conflict' },
          h('strong', {}, `${k.label} does not agree. `),
          k.items.map((i) => `Report ${i.report} says ${i.value}.`).join(' '),
          ' At least one is forged.'))
        : h('p', { class: 'muted' }, 'No two reports contradict each other. A forgery could still hide in a fact only one report mentions, so use your Verify.'));
  }

  function verifyPanel(v) {
    const logs = v.verify.log;
    return h('div', { class: 'section' },
      h('h3', {}, 'Verify'),
      h('p', { class: 'muted' }, v.verify.available
        ? 'You have 1 Verify this mission. Tap Verify next to any fact on a report that is not yours. Only you will see the answer.'
        : 'You used your Verify this mission. Your finding is marked on the report.'),
      logs.length
        ? h('ul', { class: 'list' }, logs.map((l) => h('li', {}, `${l.byName} checked Report ${l.label}, ${l.factLabel}.`)))
        : h('p', { class: 'muted small' }, 'Nobody has verified anything yet.'));
  }

  function resMap(v) {
    return new Map((v.verify ? v.verify.results : []).map((x) => [`${x.label}:${x.key}`, x.result]));
  }

  // ---------- Investigate ----------
  function screenInvestigate(v) {
    const res = resMap(v);
    return [
      banner('Compare the reports, verify one fact, and talk it out. Tap Ready when you are done.'),
      v.reports.map((r) => reportCard(v, r, { mode: 'investigate', res, canVerify: v.verify.available })),
      conflictsPanel(v.reports),
      verifyPanel(v),
      intelPanel(v),
      h('div', { class: 'section' },
        h('button', { class: 'btn btn-primary btn-wide', disabled: v.ready.you, onclick: () => act({ t: 'ready' }) },
          v.ready.you ? 'Ready. Waiting for the others' : 'I am ready to vote'),
        h('p', { class: 'muted small' }, `${v.ready.count} of ${v.ready.total} players ready. Voting starts when everyone is ready or time runs out.`)),
      chatPanel(v),
    ];
  }

  // ---------- Vote ----------
  function screenVote(v) {
    const res = resMap(v);
    const todo = v.reports.filter((r) => !r.mine);
    const locked = v.vote.submitted;
    const mine = v.vote.mine || {};
    const choice = (label) => (locked ? mine[label] : ui.ballot[label]);
    const allChosen = todo.every((r) => typeof ui.ballot[r.label] === 'boolean');
    return [
      banner(locked ? 'Ballot locked. Waiting for the others.' : 'Approve the reports you believe are true. Reject the ones you think are forged.'),
      v.reports.map((r) => {
        let extra = null;
        if (!r.mine) {
          const c = choice(r.label);
          extra = h('div', { class: 'seg' },
            h('button', { class: 'yes', 'aria-pressed': String(c === true), disabled: locked, onclick: () => { ui.ballot[r.label] = true; render(); } }, 'Approve'),
            h('button', { class: 'no', 'aria-pressed': String(c === false), disabled: locked, onclick: () => { ui.ballot[r.label] = false; render(); } }, 'Reject'));
        }
        return reportCard(v, r, { mode: 'vote', res, canVerify: false, extra });
      }),
      locked
        ? h('p', { class: 'muted' }, `${v.vote.count} of ${v.vote.total} ballots are in.`)
        : h('div', { class: 'section' },
          h('button', { class: 'btn btn-primary btn-wide', disabled: !allChosen, onclick: () => act({ t: 'vote', votes: { ...ui.ballot } }) }, 'Lock in my votes'),
          h('p', { class: 'muted small' }, allChosen ? 'Votes cannot be changed once locked.' : 'Choose Approve or Reject for every report first. A tie counts as a reject.')),
      verifyPanel(v),
      intelPanel(v),
      chatPanel(v),
    ];
  }

  // ---------- Result ----------
  function votesLine(v, r) {
    const yes = r.votes.filter((x) => x.approve).map((x) => nameOf(v, x.id));
    const no = r.votes.filter((x) => !x.approve).map((x) => nameOf(v, x.id));
    return h('div', { class: 'votes' },
      h('div', {}, `Approved (${yes.length}): ${yes.join(', ') || 'nobody'}`),
      h('div', {}, `Rejected (${no.length}): ${no.join(', ') || 'nobody'}`));
  }

  function screenResult(v) {
    const m = v.mission;
    const clean = m.outcome.clean;
    const forgedIn = v.reports.some((r) => r.forged && r.approved);
    const genuineOut = v.reports.some((r) => !r.forged && !r.approved);
    const why = [forgedIn ? 'A forged report was approved.' : null, genuineOut ? 'A true report was rejected.' : null].filter(Boolean).join(' ');
    const key = `m${m.no}`;
    const animate = !ui.stamped[key];
    ui.stamped[key] = true;
    return [
      h('div', { class: `outcome ${clean ? 'good' : 'bad'}` },
        clean ? 'Clean call. The Loyals take this mission.' : 'Compromised. The Doubles take this mission.',
        h('small', {}, clean ? 'Every true report was approved and every forgery rejected.' : why)),
      v.reports.map((r, i) => reportCard(v, r, {
        mode: 'result', animate, index: i, canVerify: false,
        extra: h('div', {},
          h('div', { class: 'verdict' }, r.correct ? 'Correct call' : 'Wrong call'),
          votesLine(v, r)),
      })),
      missionTally(v),
      h('p', { class: 'muted' }, 'The next step starts automatically.'),
    ];
  }

  // ---------- Final vote ----------
  function screenFinal(v) {
    const k = v.final.k;
    const others = v.players.filter((p) => p.id !== v.you.id);
    const locked = v.final.submitted;
    const chosen = ui.suspects;
    return [
      banner(locked ? 'Suspects locked in. Waiting for the others.' : `Name ${k} suspected Double ${plural(k, 'Agent', 'Agents')}.`),
      missionTally(v),
      h('p', { class: 'muted' }, k === 1
        ? 'Pick the one player you think is the Double Agent.'
        : `Pick exactly ${k} players. If the Doubles won the missions but every one of them is exposed, the Loyals still win.`),
      h('div', { class: 'pickgrid' }, others.map((p) => h('button', {
        class: 'pick', 'aria-pressed': String(chosen.has(p.id)), disabled: locked,
        onclick: () => {
          if (chosen.has(p.id)) chosen.delete(p.id);
          else if (chosen.size < k) chosen.add(p.id);
          render();
        },
      }, p.name))),
      locked
        ? h('p', { class: 'muted' }, `${v.final.count} of ${v.final.total} players have voted.`)
        : h('div', { class: 'section' },
          h('button', { class: 'btn btn-primary btn-wide', disabled: chosen.size !== k, onclick: () => act({ t: 'final', suspects: [...chosen] }) }, 'Lock in my suspects'),
          h('p', { class: 'muted small' }, `${chosen.size} of ${k} chosen. This cannot be changed once locked.`)),
    ];
  }

  // ---------- Results ----------
  function screenResults(v) {
    const r = v.results;
    const loyalWin = r.winner === 'loyal';
    const topNames = r.top.map((id) => r.scores.find((s) => s.id === id)).filter(Boolean);
    return [
      h('div', { class: `winner ${r.winner}` },
        h('h2', {}, loyalWin ? 'Loyal Agents win' : 'Double Agents win'),
        h('p', {}, r.reason),
        h('p', { class: 'muted small' }, `Missions: Loyals ${r.wins.loyal}, Doubles ${r.wins.double}.`)),
      h('div', { class: 'panel' },
        h('strong', {}, 'Top agent'),
        h('p', {}, `${topNames.map((s) => s.name).join(' and ')} with ${topNames[0].score} points.`)),
      h('h3', {}, 'Who was who'),
      h('ul', { class: 'players' }, r.roles.map((p) => h('li', {},
        h('span', { class: 'pname' }, p.name, p.id === v.you.id ? ' (you)' : ''),
        h('span', { class: `tag ${p.role === 'double' ? 'away' : 'on'}` }, p.role === 'double' ? 'Double agent' : 'Loyal agent'),
        p.role === 'double'
          ? h('span', { class: 'tag' }, r.exposed.includes(p.id) ? 'Exposed' : 'Stayed hidden')
          : (r.exposed.includes(p.id) ? h('span', { class: 'tag' }, 'Wrongly accused') : null)))),
      h('h3', {}, 'Scores'),
      h('table', { class: 'scores' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Role'), h('th', { class: 'num' }, 'Points'))),
        h('tbody', {}, r.scores.map((s) => h('tr', {},
          h('td', {}, s.name), h('td', {}, s.role === 'double' ? 'Double' : 'Loyal'), h('td', { class: 'num' }, s.score))))),
      h('p', { class: 'muted small' }, 'Points: +1 per correct vote and +2 per Double you named (Loyals). +2 per forgery approved and +2 for staying hidden (Doubles). +3 for the winning side.'),
      h('h3', {}, 'Mission recap'),
      r.recap.map((mi) => h('div', { class: 'panel' },
        h('strong', {}, `${mi.title}: ${mi.clean ? 'Clean call' : 'Compromised'}`),
        h('ul', { class: 'recap list' }, mi.reports.map((x) => h('li', {},
          `Report ${x.label} by ${x.filerName}: ${x.forged ? 'forged' : 'genuine'}, ${x.approved ? 'approved' : 'rejected'} (${x.approves} to ${x.rejects}).`))))),
      v.you.host
        ? h('button', { class: 'btn btn-primary btn-wide', style: 'margin-top:16px', onclick: () => send({ t: 'again' }) }, 'Play another round')
        : banner('The host can start another round.'),
      chatPanel(v),
      h('button', { class: 'btn btn-wide btn-ghost', style: 'margin-top:14px', onclick: () => { send({ t: 'leave' }); leaveToHome(null); } }, 'Leave room'),
    ];
  }

  // ---------- Chat ----------
  function chatPanel() {
    const sendChat = () => {
      const text = ui.chat.trim();
      if (!text) return;
      send({ t: 'chat', text });
      ui.chat = '';
      const input = document.getElementById('chatin');
      if (input) input.value = '';
    };
    return h('section', { class: 'chat' },
      h('h3', {}, 'Team chat'),
      h('div', { class: 'chatlist', id: 'chatlist', role: 'log', 'aria-live': 'polite' }),
      h('div', { class: 'chatform' },
        h('input', {
          type: 'text', id: 'chatin', maxlength: '140', autocomplete: 'off', value: ui.chat, placeholder: 'Say something',
          'aria-label': 'Chat message', oninput: (e) => { ui.chat = e.target.value; },
          onkeydown: (e) => { if (e.key === 'Enter') sendChat(); },
        }),
        h('button', { class: 'btn', onclick: sendChat }, 'Send')));
  }

  function renderChatList() {
    const list = document.getElementById('chatlist');
    if (!list || !S.view) return;
    list.replaceChildren(...(S.view.chat.length
      ? S.view.chat.map((c) => h('p', {}, h('b', {}, c.mine ? 'You' : c.name), ': ', c.text))
      : [h('p', { class: 'empty' }, 'No messages yet.')]));
    list.scrollTop = list.scrollHeight;
  }

  // ---------- Boot ----------
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !S.replaced && (!S.ws || S.ws.readyState > 1)) connect();
  });
  window.addEventListener('online', () => { if (!S.replaced) connect(); });
  render();
  connect();
})();
