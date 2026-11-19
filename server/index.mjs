/* =====================================================================
 *  Wincode Node Manager — server
 *    node server/index.mjs [--port 7760] [--no-virtual]
 *  A browser can neither broadcast on the network nor talk to devices on other origins, so this small server does both:
 *    · discovery   UDP broadcast {"t":"discover"} on port 7788; devices answer {"t":"hello", …}
 *    · supervision reads /api/status of every known device once a second; three misses = offline
 *    · proxy       the page's requests to /api/dev/<id>/… are forwarded to the device's own HTTP API
 *  It keeps no configuration of its own: the devices are the source of truth.
 *  By default it also starts the virtual fleet (server/virtual.mjs), so the program can be tried with no hardware.
 * ===================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startVirtual, DISCOVERY_PORT } from './virtual.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const PORT = +(arg('--port') || process.env.PORT || 7760);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.md': 'text/markdown; charset=utf-8' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let s = ''; req.on('data', c => { s += c; if (s.length > 4e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch (e) { r(null); } }); });

/* ── devices ── */
const devices = new Map();        // id → { id, url, info, config, status, online, misses, seen }
const call = async (url, opt = {}) => { const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(opt.timeout || 1200), headers: opt.body ? { 'Content-Type': 'application/json' } : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
async function adopt(url) {
  url = url.replace(/\/+$/, '');
  const info = await call(url + '/api/info');
  if (!info || !info.id || !info.type) throw new Error('not a Wincode node');
  let d = devices.get(info.id); if (!d) devices.set(info.id, d = { id: info.id, misses: 0 });
  Object.assign(d, { url, info, online: true, misses: 0, seen: Date.now() });
  d.config = await call(url + '/api/config'); d.status = await call(url + '/api/status');
  return d;
}
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.on('error', e => console.warn('[discovery]', e.message));
sock.on('message', (msg, r) => { let m; try { m = JSON.parse(msg.toString()); } catch (e) { return; } if (!m || m.t !== 'hello' || !m.id) return;
  adopt(`http://${m.ip && m.ip !== '0.0.0.0' ? m.ip : r.address}:${m.port || 80}`).catch(() => {}); });
sock.bind(() => { try { sock.setBroadcast(true); } catch (e) {} });
function scan() {
  const q = Buffer.from(JSON.stringify({ t: 'discover', v: 1 })), targets = new Set(['255.255.255.255', '127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) { const ip = i.address.split('.').map(Number), mk = i.netmask.split('.').map(Number); targets.add(ip.map((b, k) => (b | (~mk[k] & 255))).join('.')); }
  for (const t of targets) sock.send(q, DISCOVERY_PORT, t, () => {});
}
setInterval(async () => {
  await Promise.all([...devices.values()].map(async d => {
    try { d.status = await call(d.url + '/api/status', { timeout: 800 }); if (!d.online) { d.config = await call(d.url + '/api/config'); d.info = await call(d.url + '/api/info'); } d.online = true; d.misses = 0; d.seen = Date.now(); }
    catch (e) { if (++d.misses >= 3) d.online = false; }
  }));
}, 1000);
setInterval(scan, 10000);

/* ── http ── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = decodeURIComponent(url.pathname);
  try {
    if (p === '/api/ping') return json(res, 200, { app: 'wincode-node-manager', version: 1 });
    if (p === '/api/devices') return json(res, 200, [...devices.values()].map(d => ({ id: d.id, url: d.url, online: d.online, seen: d.seen, info: d.info, config: d.config, status: d.status })));
    if (p === '/api/scan' && req.method === 'POST') { scan(); return json(res, 200, { ok: true }); }
    if (p === '/api/add' && req.method === 'POST') { const b = await readBody(req); const d = await adopt(/^https?:\/\//.test(b.url) ? b.url : 'http://' + b.url); return json(res, 200, { ok: true, id: d.id }); }
    if (p === '/api/forget' && req.method === 'POST') { const b = await readBody(req); devices.delete(b.id); return json(res, 200, { ok: true }); }
    const m = /^\/api\/dev\/([^/]+)\/(config|action)$/.exec(p);
    if (m) {
      const d = devices.get(m[1]); if (!d) return json(res, 404, { ok: false, error: 'unknown device' });
      const b = await readBody(req); if (!b) return json(res, 400, { ok: false, error: 'bad JSON' });
      if (m[2] === 'config' && req.method === 'PUT') { d.config = await call(d.url + '/api/config', { method: 'PUT', body: JSON.stringify(b) }); d.info = await call(d.url + '/api/info').catch(() => d.info); return json(res, 200, d.config); }
      if (m[2] === 'action' && req.method === 'POST') { const r = await call(d.url + '/api/action', { method: 'POST', body: JSON.stringify(b) }); d.config = await call(d.url + '/api/config').catch(() => d.config); d.status = await call(d.url + '/api/status').catch(() => d.status); return json(res, 200, r); }   // an action may change both (identify, factory, home …)
    }
    if (p.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) { return json(res, 502, { ok: false, error: e.message }); }
  const base = p.startsWith('/docs/') ? path.join(ROOT, '..') : ROOT, file = path.normalize(path.join(base, p === '/' ? 'index.html' : p));
  if (!file.startsWith(path.normalize(path.join(ROOT, '..')))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => { if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(buf); });
});
server.listen(PORT, '127.0.0.1', () => { console.log(`Wincode Node Manager → http://127.0.0.1:${PORT}`); if (!process.argv.includes('--no-virtual')) startVirtual(); setTimeout(scan, 300); });
