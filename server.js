'use strict';
// Minimal Xray VLESS + WebSocket node for Pxxl (free tier).
// Node.js listens on $PORT and proxies WebSocket upgrades at /airport to
// an Xray process bound to 127.0.0.1. The Xray binary is downloaded on
// first start from the official Xray-core GitHub release.
// The app directory is read-only at runtime on Pxxl, so the binary,
// config and download all live in the OS temp directory (writable).
// The HTTP server starts listening on $PORT immediately, so the platform
// health check passes while Xray is still downloading.
// Required env var: UUID (the VLESS client id). Optional: WS_PATH (default /airport).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '8080', 10);
const WS_PATH = process.env.WS_PATH || '/airport';
const UUID = process.env.UUID || process.env.VLESS_UUID || '';
const XRAY_PORT = parseInt(process.env.XRAY_PORT || '10800', 10);
const XRAY_URL = process.env.XRAY_URL || 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';
const WORKDIR = path.join(os.tmpdir(), 'pxxl-node');
const XRAY_BIN = path.join(WORKDIR, 'xray');
const CONFIG_PATH = path.join(WORKDIR, 'config.json');
const ZIP_PATH = path.join(WORKDIR, 'xray.zip');

try { fs.mkdirSync(WORKDIR, { recursive: true }); } catch (e) {}

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
function extractXrayZip(zipPath) {
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
      fs.writeFileSync(XRAY_BIN, out, { mode: 0o755 });
      return true;
    }
    off = dataStart + compSize;
  }
  return false;
}

function tryUnzip(zipPath) {
  return new Promise((resolve) => {
    execFile('unzip', ['-o', zipPath, 'xray', '-d', WORKDIR], (err) => {
      if (err) return resolve(false);
      try { fs.chmodSync(XRAY_BIN, 0o755); resolve(fs.existsSync(XRAY_BIN)); } catch (e) { resolve(false); }
    });
  });
}

async function ensureXray() {
  if (fs.existsSync(XRAY_BIN)) {
    try { fs.chmodSync(XRAY_BIN, 0o755); } catch (e) {}
    console.log('[pxxl-node] xray binary already present');
    return;
  }
  console.log('[pxxl-node] downloading Xray from ' + XRAY_URL);
  await download(XRAY_URL, ZIP_PATH);
  console.log('[pxxl-node] extracting xray binary');
  let ok = false;
  try { ok = extractXrayZip(ZIP_PATH); } catch (e) { console.log('[pxxl-node] built-in unzip failed: ' + e.message); }
  if (!ok) ok = await tryUnzip(ZIP_PATH);
  try { fs.unlinkSync(ZIP_PATH); } catch (e) {}
  if (!ok || !fs.existsSync(XRAY_BIN)) throw new Error('could not obtain the xray binary');
}

function writeConfig() {
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function main() {
  let xrayReady = false;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== WS_PATH || !xrayReady) { socket.destroy(); return; }
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
  // Start Xray in the background; health checks already pass via the HTTP server above.
  try {
    await ensureXray();
    writeConfig();
    const xray = spawn(XRAY_BIN, ['run', '-c', CONFIG_PATH], { stdio: ['ignore', 'inherit', 'inherit'] });
    xray.on('exit', (code) => { console.error('[pxxl-node] xray exited with code ' + code); process.exit(code || 1); });
    xray.on('error', (err) => { console.error('[pxxl-node] failed to start xray: ' + err.message); process.exit(1); });
    xrayReady = true;
    console.log('[pxxl-node] xray started');
  } catch (err) {
    console.error('[pxxl-node] ' + (err && err.message ? err.message : err));
    process.exit(1);
  }
}

process.on('SIGTERM', () => process.exit(0));
main();
