/* =====================================================================
 *  virtual.mjs — a fleet of virtual Wincode nodes on this computer.
 *  Each one speaks the device API of docs/DEVICE-API.md exactly as the firmware must:
 *    · UDP 7788: answers {"t":"discover"} with one {"t":"hello", …} per device
 *    · HTTP (one port per device, 7801 …): /api/info · /api/config · /api/status · /api/action
 *      and, virtual devices only, /api/frame: what the outputs do right now (pixel colours, winch motion) for the
 *      manager's Simulator view — pixel data as base64 r, g, b bytes
 *  They also listen for real Art-Net (UDP 6454) and sACN (UDP 5568, multicast): when a console sends the universes a
 *  device is set to, the device follows that traffic instead of the built-in stand-in. Art-Net is taken on every
 *  address and, separately, on 127.0.0.2: on one computer only one program gets a unicast packet for 127.0.0.1 (the
 *  fixture simulator may hold it), so a console on this computer reaches the virtual nodes at 127.0.0.2.
 *    node server/virtual.mjs            the fleet alone
 * ===================================================================== */
import http from 'node:http';
import dgram from 'node:dgram';
import { demoFleet } from '../web/js/vdevice.js';

export const DISCOVERY_PORT = 7788;
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch (e) { r(null); } }); });

const b64 = u8 => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
/** a frame with its pixel arrays as base64 */
export const packFrame = f => (f.type === 'winch' ? { ...f, pixels: b64(f.pixels) } : f.type === 'pixel' ? { ...f, ports: f.ports.map(p => ({ ...p, pixels: b64(p.pixels) })) } : f.type === 'edmx' ? { ...f, ports: f.ports.map(p => ({ ...p, out: b64(p.out) })) } : f);

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
      if (p === '/api/frame' && req.method === 'GET') return json(res, 200, packFrame(d.frame()));
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
  const feed = (u, data, source) => { const copy = Uint8Array.from(data); for (const d of fleet) d.feed(u, copy, true, source); };
  const art = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  art.on('error', e => log('[virtual] Art-Net not available:', e.code || e.message));
  art.on('message', (m, r) => { if (m.length > 18 && m.toString('latin1', 0, 7) === 'Art-Net' && m.readUInt16LE(8) === 0x5000) feed(m.readUInt16LE(14) & 0x7fff, m.subarray(18, 18 + m.readUInt16BE(16)), `Art-Net ${r ? r.address : '?'}`); });   // a source per sender address
  art.bind(6454);
  const art2 = dgram.createSocket({ type: 'udp4', reuseAddr: true });                        // the virtual nodes' own address on this computer
  art2.on('error', e => log('[virtual] Art-Net on 127.0.0.2 not available:', e.code || e.message));
  art2.on('message', (m, r) => art.emit('message', m, r));
  art2.bind(6454, '127.0.0.2');
  const acn = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  acn.on('error', e => log('[virtual] sACN not available:', e.code || e.message));
  acn.on('message', m => { if (m.length > 126 && m.readUInt32BE(18) === 4) feed(m.readUInt16BE(113), m.subarray(126), `sACN ${m.toString('utf8', 44, 108).replace(/\0.*$/s, '') || m.subarray(22, 38).toString('hex').slice(0, 8)}`); });   // a source per sACN source name (or CID)
  acn.bind(5568, () => { for (let u = 1; u <= 64; u++) try { acn.addMembership(`239.255.${u >> 8}.${u & 255}`); } catch (e) {} });

  log(`[virtual] ${fleet.length} virtual nodes on http://127.0.0.1:${basePort}–${basePort + fleet.length - 1}, discovery on UDP ${DISCOVERY_PORT}`);
  return fleet;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) startVirtual();
