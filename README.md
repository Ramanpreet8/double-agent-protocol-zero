# Double Agent: Protocol Zero

A real-time multiplayer deduction game for 4 to 8 players. Some intelligence reports are
genuine. Others are forged by hidden Double Agents. Compare reports, verify facts, and vote
on what to trust. Players join from their own phones with a 4-letter room code. No accounts,
nothing to install.

- One game takes about 10 minutes: up to 3 missions, then an Exposure Vote.
- The server is the referee. Roles, hidden facts, votes, scores and winners are decided on the
  server, and each player only ever receives what they are allowed to see.
- No dependencies. Only Node.js (version 20 or newer) is required.

## AI use disclosure

AI tools were used extensively during development of this project, including to help plan,
write, review, test, and refine the game and its interface. The project creator reviewed and
tested the resulting work, including running the multiplayer test suite and playing a complete
four-player browser game.

## 1. Run it on your computer

1. Install Node.js from https://nodejs.org (the "LTS" version).
2. Open a terminal in this folder and run:

   ```
   node server.js
   ```

3. Open http://localhost:3000 in your browser. Open a second window (a private/incognito
   window works) to act as a second player.

To test with real phones on the same Wi-Fi, find your computer's local address (for example
192.168.1.20) and open `http://192.168.1.20:3000` on the phone. Note that `localhost` only works
on your own computer. It is NOT a public link.

## 2. Put it on the internet (needed for the contest)

The game needs a host that keeps a server running and allows WebSocket connections.
Netlify and Vercel's static hosting are NOT suitable. Render works and has a free tier.
(Before using anything else, ask your AI tool whether ChatGPT Sites supports a persistent
WebSocket server. If it does, that is also fine.)

On Render (screens and wording may change slightly):

1. Create a free GitHub account and a new repository. Upload every file in this folder to it.
2. Create a free account at https://render.com and choose New > Web Service (or New > Blueprint,
   which reads `render.yaml`).
3. Connect your GitHub repository. Use these settings if asked:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
   - Health check path: `/health`
4. Keep it to ONE instance. Live games are kept in server memory.
5. When the deploy finishes, Render shows your public address, such as
   `https://double-agent-protocol-zero.onrender.com`.
6. Open that address in a private window on your phone (use mobile data, not your Wi-Fi) and
   play with a friend to confirm it works across networks.

Important notes about free hosting:
- Free services usually go to sleep when nobody visits, and the first load can take about a
  minute. Open your link a couple of minutes before showing it to anyone or before judging.
- If the server restarts, games in progress are lost. Players see "Room not found" and can
  start a new room.

## 3. Run the tests

```
npm test
```

This starts the real server and connects real WebSocket clients to play full games at several
player counts. It checks scoring, win conditions, privacy of secret information, duplicate and
stale actions, reconnects and more. It takes about two minutes.

## Rules in brief

- Most players are Loyal Agents. 4 players: 1 Double. 5-6 players: 2 Doubles. 7-8 players: 3.
- Each mission, a few players file anonymous reports. Each report states 2 of the mission's 5
  facts. Loyal reports are true. A Double chooses between a true and a forged version.
- Compare reports. If two disagree on a fact, one is forged. Once per mission you can Verify one
  fact on someone else's report. Only you see the answer, and you may lie about it.
- Everyone votes Approve or Reject on every report except their own. A tie is a Reject. A mission
  is a Clean Call (Loyal point) only if every true report is approved and every forgery rejected.
  Otherwise the Doubles score.
- First side to 2 missions wins the race. Then everyone names suspects (Exposure Vote). The
  Doubles win unless the Loyals won the missions or exposed every Double.
- Scoring: Loyals get +1 per correct vote and +2 per Double they named. Doubles get +2 per
  forgery approved and +2 for staying hidden. The winning side gets +3 each.

## Change the game

- Timers, player counts, team sizes: the settings at the top of `lib/game.js`.
- Missions: `lib/missions.js`. Copy one block, keep exactly 5 facts, and make each fake value
  believable but different from the true one.
- Look and feel: `public/style.css`.

## Project layout

```
server.js          web server + WebSocket connection point
lib/ws.js          small WebSocket implementation (no packages needed)
lib/game.js        all game rules, phases, validation, scoring, per-player views
lib/missions.js    the mission pool
public/            the game screens (HTML, CSS, JavaScript)
test/              end-to-end tests
submission/        contest submission text and cover image
render.yaml        Render hosting settings
```
