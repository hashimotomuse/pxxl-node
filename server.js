'use strict';
// Minimal Xray VLESS + WebSocket node for Pxxl (free tier), with a built-in
// pure-Node VLESS fallback.
//
// Node.js listens on $PORT and proxies WebSocket upgrades at /airport to an
// Xray process bound to 127.0.0.1. The Xray binary is downloaded on first
// start from the official Xray-core GitHub release.
//
// Pxxl's runtime is strict: the app directory (/workspace/app) is read-only,
// and every writable directory (/var/tmp, /dev/shm, /tmp) is mounted noexec,
// so a downloaded binary cannot be executed directly. This file therefore
// tries to run Xray through the system dynamic loader (ld-linux, which only
// needs the binary to be readable) and, if that is impossible too, serves
// VLESS + WebSocket directly from Node.js (TCP only).
//
// The HTTP server starts listening on $PORT immediately, so the platform
// health check passes while Xray is still being set up.
// Required env var: UUID (the VLESS client id). Optional: WS_PATH (default /airport).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '8080', 10);
const WS_PATH = process.env.WS_PATH || '/airport';
const UUID = process.env.UUID || process.env.VLESS_UUID || '';
const XRAY_PORT = parseInt(process.env.XRAY_PORT || '10800', 10);
const XRAY_URL = process.env.XRAY_URL || 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';
const LOADERS = ['/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'];
let homeDir = '';
try { homeDir = os.homedir(); } catch (e) {}
const CANDIDATE_DIRS = [...new Set([
  process.env.XRAY_DIR || '',
  '/var/tmp/pxxl-node',
  homeDir ? path.join(homeDir, '.pxxl-node') : '',
  '/dev/shm/pxxl-node',
  path.join(os.tmpdir(), 'pxxl-node'),
].filter(Boolean))];

if (!UUID) {
  console.error('[pxxl-node] UUID environment variable is not set. Set UUID in the Pxxl dashboard and redeploy.');
  process.exit(1);
}

function download(url, dest, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    file.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    https.get(url, { headers: { 'User-Agent': 'pxxl-node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects > 10) return reject(new Error('too many redirects'));
        file.close();
        fs.unlink(dest, () => {});
        return download(new URL(res.headers.location, url).toString(), dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('download failed: HTTP ' + res.statusCode));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
  });
}

// Extract only the "xray" entry from a zip file using only Node built-ins.
function extractXrayZip(zipPath, binPath) {
  const buf = fs.readFileSync(zipPath);
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    const flags = buf.readUInt16LE(off + 6);
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    if (flags & 0x08) throw new Error('zip uses data descriptors, unsupported');
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (name === 'xray') {
      let out;
      if (method === 0) out = Buffer.from(data);
      else if (method === 8) out = zlib.inflateRawSync(data);
      else throw new Error('unsupported zip method ' + method);
      fs.writeFileSync(binPath, out, { mode: 0o755 });
      return true;
    }
    off = dataStart + compSize;
  }
  return false;
}

function tryUnzip(zipPath, dir) {
  return new Promise((resolve) => {
    execFile('unzip', ['-o', zipPath, 'xray', '-d', dir], (err) => {
      if (err) return resolve(false);
      try { fs.chmodSync(path.join(dir, 'xray'), 0o755); resolve(fs.existsSync(path.join(dir, 'xray'))); } catch (e) { resolve(false); }
    });
  });
}

function checkWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.writable');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    console.log('[pxxl-node] cannot write in ' + dir + ': ' + e.message);
    return false;
  }
}

async function ensureXray(dir) {
  const bin = path.join(dir, 'xray');
  const zip = path.join(dir, 'xray.zip');
  if (fs.existsSync(bin)) {
    try { fs.chmodSync(bin, 0o755); } catch (e) {}
    console.log('[pxxl-node] xray binary already present in ' + dir);
    return true;
  }
  console.log('[pxxl-node] downloading Xray from ' + XRAY_URL);
  await download(XRAY_URL, zip);
  console.log('[pxxl-node] extracting xray binary');
  let ok = false;
  try { ok = extractXrayZip(zip, bin); } catch (e) { console.log('[pxxl-node] built-in unzip failed: ' + e.message); }
  if (!ok) ok = await tryUnzip(zip, dir);
  try { fs.unlinkSync(zip); } catch (e) {}
  if (ok && fs.existsSync(bin)) {
    try { console.log('[pxxl-node] xray binary mode: ' + (fs.statSync(bin).mode & 0o777).toString(8)); } catch (e) {}
  }
  return ok && fs.existsSync(bin);
}

function writeConfig(dir) {
  const config = {
    log: { loglevel: 'warning' },
    inbounds: [{
      port: XRAY_PORT,
      listen: '127.0.0.1',
      protocol: 'vless',
      settings: { clients: [{ id: UUID }], decryption: 'none' },
      streamSettings: { network: 'ws', wsSettings: { path: WS_PATH } }
    }],
    outbounds: [{ protocol: 'freedom', settings: {} }]
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

// Try to run the binary through the system dynamic loader. The loader only
// needs the file to be readable, so this can work on a noexec filesystem.
function tryLoader(bin) {
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= LOADERS.length) return resolve(null);
      const ld = LOADERS[i];
      if (!fs.existsSync(ld)) return tryNext(i + 1);
      execFile(ld, [bin, 'version'], { timeout: 5000 }, (err, stdout, stderr) => {
        const out = (stdout || '') + (stderr || '');
        if (!err && /xray/i.test(out)) {
          console.log('[pxxl-node] dynamic loader works: ' + ld);
          return resolve(ld);
        }
        console.log('[pxxl-node] loader ' + ld + ' cannot run the binary: ' + (err ? err.message : 'no version output'));
        tryNext(i + 1);
      });
    };
    tryNext(0);
  });
}

function startXray(dir, loader) {
  const bin = path.join(dir, 'xray');
  const cfg = path.join(dir, 'config.json');
  const args = loader ? [bin, 'run', '-c', cfg] : ['run', '-c', cfg];
  const cmd = loader || bin;
  return new Promise((resolve) => {
    let settled = false;
    const xray = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.log('[pxxl-node] xray started from ' + dir + (loader ? ' via ' + loader : ''));
      xray.on('exit', (code) => { console.error('[pxxl-node] xray exited with code ' + code); process.exit(code || 1); });
      resolve('running');
    }, 2000);
    xray.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error('[pxxl-node] failed to start xray in ' + dir + ': ' + err.message);
      resolve('spawn_error');
    });
    xray.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error('[pxxl-node] xray exited early in ' + dir + ' with code ' + code);
      resolve('exited_early');
    });
  });
}

// Built-in VLESS + WebSocket implementation (TCP only). Used when no Xray
// binary can be executed in this sandbox.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const UUID_BYTES = Buffer.from(UUID.replace(/-/g, ''), 'hex');

function sendWsFrame(socket, opcode, data) {
  let hb;
  const len = data.length;
  const first = 0x80 | opcode;
  if (len < 126) hb = Buffer.from([first, len]);
  else if (len < 65536) { hb = Buffer.alloc(4); hb[0] = first; hb[1] = 126; hb.writeUInt16BE(len, 2); }
  else { hb = Buffer.alloc(10); hb[0] = first; hb[1] = 127; hb.writeBigUInt64BE(BigInt(len), 2); }
  socket.write(Buffer.concat([hb, data]));
}

function handleNodeVless(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  let closed = false;
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let frag = null;
  let header = null;
  let target = null;
  let connected = false;
  let queue = [];
  function close() {
    if (closed) return;
    closed = true;
    try { socket.destroy(); } catch (e) {}
    if (target) { try { target.destroy(); } catch (e) {} }
  }
  function sendFrame(data) {
    if (!closed) { try { sendWsFrame(socket, 0x2, data); } catch (e) { close(); } }
  }
  function onMessage(payload) {
    if (closed) return;
    if (!header) {
      if (payload.length < 24) { close(); return; }
      const version = payload[0];
      if (!payload.subarray(1, 17).equals(UUID_BYTES)) {
        console.log('[pxxl-node] VLESS: client UUID does not match');
        close();
        return;
      }
      const addonLen = payload[17];
      let p = 18 + addonLen;
      if (payload.length < p + 4) { close(); return; }
      const cmd = payload[p]; p += 1;
      const port = payload.readUInt16BE(p); p += 2;
      const atype = payload[p]; p += 1;
      let addr = '';
      if (atype === 1) {
        if (payload.length < p + 4) { close(); return; }
        addr = payload[p] + '.' + payload[p + 1] + '.' + payload[p + 2] + '.' + payload[p + 3];
        p += 4;
      } else if (atype === 2) {
        const l = payload[p]; p += 1;
        if (payload.length < p + l) { close(); return; }
        addr = payload.toString('utf8', p, p + l);
        p += l;
      } else if (atype === 3) {
        if (payload.length < p + 16) { close(); return; }
        const parts = [];
        for (let i = 0; i < 16; i += 2) parts.push(payload.readUInt16BE(p + i).toString(16));
        addr = '[' + parts.join(':') + ']';
        p += 16;
      } else { close(); return; }
      if (cmd !== 1) { console.log('[pxxl-node] VLESS: unsupported command ' + cmd + ' (only TCP is supported)'); close(); return; }
      header = { version, port, addr };
      const rest = payload.subarray(p);
      target = net.connect(port, addr);
      target.on('connect', () => {
        connected = true;
        sendFrame(Buffer.from([version, 0x00]));
        for (const q of queue) { try { target.write(q); } catch (e) {} }
        queue = [];
        if (rest.length) { try { target.write(rest); } catch (e) {} }
      });
      target.on('data', (d) => sendFrame(d));
      target.on('error', (err) => { console.log('[pxxl-node] VLESS target error: ' + err.message); close(); });
      target.on('close', () => close());
      return;
    }
    if (connected && target) { try { target.write(payload); } catch (e) { close(); } }
    else queue.push(payload);
  }
  socket.on('data', (chunk) => {
    if (closed) return;
    buf = Buffer.concat([buf, chunk]);
    while (!closed) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > 10000000n) { close(); return; }
        len = Number(big);
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x8) { close(); return; }
      if (opcode === 0x9) { try { sendWsFrame(socket, 0xA, payload); } catch (e) { close(); return; } continue; }
      if (opcode === 0xA) continue;
      if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) { close(); return; }
      if (!fin) { frag = frag ? Buffer.concat([frag, payload]) : Buffer.from(payload); continue; }
      const msg = frag ? Buffer.concat([frag, payload]) : payload;
      frag = null;
      onMessage(msg);
    }
  });
  socket.on('error', () => close());
  socket.on('close', () => close());
}

async function main() {
  let xrayReady = false;
  let proxyMode = 'xray';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== WS_PATH) { socket.destroy(); return; }
    if (proxyMode === 'node') { handleNodeVless(req, socket, head); return; }
    if (!xrayReady) { socket.destroy(); return; }
    const upstream = net.connect(XRAY_PORT, '127.0.0.1');
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.on('connect', () => {
      const lines = ['GET ' + WS_PATH + ' HTTP/1.1', 'Host: 127.0.0.1:' + XRAY_PORT, 'Upgrade: websocket', 'Connection: Upgrade'];
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (['host', 'upgrade', 'connection'].includes(lk)) continue;
        lines.push(k + ': ' + v);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });
  server.listen(PORT, () => {
    console.log('[pxxl-node] listening on port ' + PORT + ', WebSocket path ' + WS_PATH + ', Xray on 127.0.0.1:' + XRAY_PORT);
  });
  // Try to run the real Xray core first; fall back to the built-in VLESS
  // implementation when the sandbox will not execute the downloaded binary.
  for (const dir of CANDIDATE_DIRS) {
    console.log('[pxxl-node] trying working directory ' + dir);
    if (!checkWritable(dir)) continue;
    try {
      if (!(await ensureXray(dir))) { console.log('[pxxl-node] could not obtain the xray binary in ' + dir); continue; }
      writeConfig(dir);
      const loader = await tryLoader(path.join(dir, 'xray'));
      const result = await startXray(dir, loader);
      if (result === 'running') { xrayReady = true; break; }
    } catch (err) {
      console.error('[pxxl-node] setup failed in ' + dir + ': ' + (err && err.message ? err.message : err));
    }
  }
  if (!xrayReady) {
    proxyMode = 'node';
    console.log('[pxxl-node] using built-in VLESS implementation (no Xray binary could be executed in this sandbox)');
  }
}

process.on('SIGTERM', () => process.exit(0));
main();
