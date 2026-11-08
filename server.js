'use strict';
// Minimal Xray VLESS + WebSocket node for Pxxl (free tier).
// Node.js listens on $PORT and proxies WebSocket upgrades at /airport to
// an Xray process bound to 127.0.0.1. The Xray binary is downloaded on
// first start from the official Xray-core GitHub release.
// Pxxl's runtime is strict: the app directory (/workspace/app) is read-only
// and /tmp is mounted noexec, so this file probes several directories for
// one that is both writable AND executable (/var/tmp, $HOME, /dev/shm, /tmp)
// and runs Xray from the first that works.
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

// A directory is usable only if files can be executed from it (/tmp is noexec on Pxxl).
function probeDir(dir) {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, 'probe.sh');
      fs.writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      execFile(probe, (err) => {
        try { fs.unlinkSync(probe); } catch (e) {}
        if (err) {
          console.log('[pxxl-node] cannot execute files in ' + dir + ': ' + err.message);
          return resolve(false);
        }
        resolve(true);
      });
    } catch (e) {
      console.log('[pxxl-node] cannot use ' + dir + ': ' + e.message);
      resolve(false);
    }
  });
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

function startXray(dir) {
  const bin = path.join(dir, 'xray');
  const cfg = path.join(dir, 'config.json');
  return new Promise((resolve) => {
    let settled = false;
    const xray = spawn(bin, ['run', '-c', cfg], { stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.log('[pxxl-node] xray started from ' + dir);
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
  for (const dir of CANDIDATE_DIRS) {
    console.log('[pxxl-node] trying working directory ' + dir);
    if (!(await probeDir(dir))) continue;
    try {
      if (!(await ensureXray(dir))) { console.log('[pxxl-node] could not obtain the xray binary in ' + dir); continue; }
      writeConfig(dir);
      const result = await startXray(dir);
      if (result === 'running') { xrayReady = true; break; }
    } catch (err) {
      console.error('[pxxl-node] setup failed in ' + dir + ': ' + (err && err.message ? err.message : err));
    }
  }
  if (!xrayReady) {
    console.error('[pxxl-node] no working directory for the Xray binary. Tried: ' + CANDIDATE_DIRS.join(', ') + '. The app directory is read-only and /tmp is mounted noexec.');
    process.exit(1);
  }
}

process.on('SIGTERM', () => process.exit(0));
main();
