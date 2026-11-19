/* =====================================================================
 *  virtual.mjs — a fleet of virtual Wincode nodes on this computer.
 *  Each one speaks the device API of docs/DEVICE-API.md exactly as the firmware must:
 *    · UDP 7788: answers {"t":"discover"} with one {"t":"hello", …} per device
 *    · HTTP (one port per device, 7801 …): /api/info · /api/config · /api/status · /api/action
 *  They also listen for real Art-Net (UDP 6454, broadcast) and sACN (UDP 5568, multicast): when a console sends the
 *  universes a device is set to, its status shows that traffic instead of the built-in stand-in.
 *    node server/virtual.mjs            the fleet alone
 * ===================================================================== */
import http from 'node:http';
import dgram from 'node:dgram';
import { demoFleet } from '../web/js/vdevice.js';

export const DISCOVERY_PORT = 7788;
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch (e) { r(null); } }); });

export function startVirtual({ basePort = 7801, log = console.log } = {}) {
  const fleet = demoFleet(true), ports = new Map();
  fleet.forEach((d, i) => {
    const port = basePort + i; ports.set(d.id, port);
    http.createServer(async (req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (req.method === 'OPTIONS') return json(res, 204, {});
      if (d.bootAt && d.t < d.bootAt) { res.destroy(); return; }                       // rebooting: no answer, as a real device
      if (p === '/api/info' && req.method === 'GET') return json(res, 200, d.info());
      if (p === '/api/config' && req.method === 'GET') return json(res, 200, d.config());
      if (p === '/api/config' && req.method === 'PUT') { const b = await body(req); return b ? json(res, 200, d.setConfig(b)) : json(res, 400, { ok: false, error: 'bad JSON' }); }
      if (p === '/api/status' && req.method === 'GET') return json(res, 200, d.status());
      if (p === '/api/action' && req.method === 'POST') { const b = await body(req); const r = b ? d.action(b) : { ok: false, error: 'bad JSON' }; return json(res, r.ok ? 200 : 400, r); }
      json(res, 404, { ok: false, error: 'not found' });
    }).listen(port, '127.0.0.1');
  });
  let last = performance.now();
  setInterval(() => { const now = performance.now(), dt = Math.min(0.2, (now - last) / 1000); last = now; for (const d of fleet) d.tick(dt); }, 50);

  // discovery
  const disc = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  disc.on('error', e => log('[virtual] discovery socket:', e.message));
  disc.on('message', (msg, r) => { let m; try { m = JSON.parse(msg.toString()); } catch (e) { return; } if (!m || m.t !== 'discover') return;
    for (const d of fleet) if (!(d.bootAt && d.t < d.bootAt)) disc.send(JSON.stringify({ t: 'hello', v: 1, ...d.info(), ip: '127.0.0.1', port: ports.get(d.id) }), r.port, r.address); });
  disc.bind(DISCOVERY_PORT);

  // real DMX traffic (best effort: another program may hold these ports)
  const feed = (u, data) => { for (const d of fleet) d.feed(u, data, true); };
  const art = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  art.on('error', e => log('[virtual] Art-Net not available:', e.code || e.message));
  art.on('message', m => { if (m.length > 18 && m.toString('latin1', 0, 7) === 'Art-Net' && m.readUInt16LE(8) === 0x5000) feed(m.readUInt16LE(14) & 0x7fff, m.subarray(18, 18 + m.readUInt16BE(16))); });
  art.bind(6454);
  const acn = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  acn.on('error', e => log('[virtual] sACN not available:', e.code || e.message));
  acn.on('message', m => { if (m.length > 126 && m.readUInt32BE(18) === 4) feed(m.readUInt16BE(113), m.subarray(126)); });
  acn.bind(5568, () => { for (let u = 1; u <= 64; u++) try { acn.addMembership(`239.255.${u >> 8}.${u & 255}`); } catch (e) {} });

  log(`[virtual] ${fleet.length} virtual nodes on http://127.0.0.1:${basePort}–${basePort + fleet.length - 1}, discovery on UDP ${DISCOVERY_PORT}`);
  return fleet;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) startVirtual();
