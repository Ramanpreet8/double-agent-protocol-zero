'use strict';
/*
 * Double Agent: Protocol Zero - server entry point.
 * Serves the web page (public/) and the real-time game connection (/ws).
 * No npm packages are needed: `node server.js` is all it takes.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { acceptUpgrade } = require('./lib/ws');
const game = require('./lib/game');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function clientIp(req) {
  // Hosts like Render put the real visitor address in X-Forwarded-For.
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function securityHeaders(extra) {
  return Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'none'",
  }, extra);
}

function createServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, securityHeaders({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }));
      return res.end(JSON.stringify({ ok: true, ...game.stats() }));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, securityHeaders());
      return res.end();
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { // block ../ tricks
      res.writeHead(403, securityHeaders());
      return res.end('Forbidden');
    }
    return fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
        return res.end('Not found');
      }
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, securityHeaders({ 'Content-Type': type, 'Cache-Control': 'no-cache' }));
      return res.end(req.method === 'HEAD' ? undefined : data);
    });
  });

  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    // Only accept connections from pages served by this same site.
    if (url.pathname !== '/ws' || (origin && new URL(origin).host !== req.headers.host)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const conn = acceptUpgrade(req, socket);
    if (!conn) return;
    sockets.add(conn);
    conn.on('close', () => sockets.delete(conn));
    game.handleConnection(conn, clientIp(req));
  });

  // Keep connections alive through proxies and drop dead ones.
  const keepalive = setInterval(() => {
    for (const c of sockets) {
      if (!c.alive) { c._finish(); continue; }
      c.alive = false;
      c.ping();
    }
  }, 25000);
  const ticker = setInterval(() => game.tick(), 1000);
  server.on('close', () => { clearInterval(keepalive); clearInterval(ticker); });
  server.sockets = sockets;
  return server;
}

function start(port) {
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

module.exports = { start, createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  start(port).then(() => {
    console.log('\n  Double Agent: Protocol Zero is running.');
    console.log(`  Open on this computer:  http://localhost:${port}`);
    console.log('  (Press Ctrl+C to stop.)\n');
  });
}
