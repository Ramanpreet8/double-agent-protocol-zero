'use strict';
/*
 * A tiny, dependency-free WebSocket implementation (RFC 6455).
 * It only supports what this game needs: text messages, ping/pong, close.
 * Written by hand so the project needs no `npm install` at all.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 16 * 1024; // 16 KB per message is plenty for this game

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this.alive = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragBytes = 0;
    this.fragOpcode = 0;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('end', () => this._finish());
    socket.on('error', () => this._finish());
  }

  _finish() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
    this.emit('close');
  }

  _onData(chunk) {
    if (!this.open) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // Parse as many complete frames as we have.
    while (this.open && this.buffer.length >= 2) {
      const buf = this.buffer;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0 || !masked) return this.close(1002, 'protocol error');
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009, 'too big');
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009, 'too big');
      const isControl = opcode >= 0x8;
      if (isControl && (!fin || len > 125)) return this.close(1002, 'bad control frame');
      if (buf.length < offset + 4 + len) return; // wait for the rest

      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = buf.subarray(offset + 4 + len);

      if (opcode === 0x8) { // close
        this.close(1000, 'bye');
        return;
      } else if (opcode === 0x9) { // ping
        this._writeFrame(0xA, payload);
      } else if (opcode === 0xA) { // pong
        this.alive = true;
      } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) {
          this.fragments = [];
          this.fragBytes = 0;
          this.fragOpcode = opcode;
        } else if (!this.fragOpcode) {
          return this.close(1002, 'unexpected continuation');
        }
        this.fragments.push(payload);
        this.fragBytes += payload.length;
        if (this.fragBytes > MAX_PAYLOAD) return this.close(1009, 'too big');
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          const wasText = this.fragOpcode === 0x1;
          this.fragments = [];
          this.fragBytes = 0;
          this.fragOpcode = 0;
          if (wasText) this.emit('message', whole.toString('utf8'));
        }
      } else {
        return this.close(1002, 'unknown opcode');
      }
    }
  }

  _writeFrame(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) {
      this._finish();
    }
  }

  send(text) {
    this._writeFrame(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    this._writeFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason, 'utf8').subarray(0, 100);
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this._writeFrame(0x8, payload);
    try { this.socket.end(); } catch (e) { /* ignore */ }
    setTimeout(() => this._finish(), 500).unref();
  }
}

/** Complete the HTTP -> WebSocket handshake. Returns a WSConnection or null. */
function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (upgrade !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return new WSConnection(socket);
}

module.exports = { acceptUpgrade, WSConnection };
