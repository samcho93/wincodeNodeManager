// api.js — where the device list comes from.
//  live: the manager server (server/index.mjs) discovers the devices and forwards requests to them.
//  demo: no server (for instance on a static web host) — a fleet of virtual devices runs inside this page, with the same
//        model the firmware specification is written from, so every screen can be tried.
import { demoFleet } from './vdevice.js';

const bytes = s => Uint8Array.from(atob(s || ''), c => c.charCodeAt(0));
/** a frame from a virtual device's /api/frame: pixel arrays arrive as base64 */
const unpack = f => (f.type === 'winch' ? { ...f, pixels: bytes(f.pixels) } : f.type === 'pixel' ? { ...f, ports: f.ports.map(p => ({ ...p, pixels: bytes(p.pixels) })) } : f.type === 'edmx' ? { ...f, ports: f.ports.map(p => ({ ...p, out: bytes(p.out) })) } : f);

const j = async (url, opt) => { const r = await fetch(url, opt ? { method: opt.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opt.body || {}) } : undefined); const x = await r.json().catch(() => ({})); if (!r.ok) throw new Error(x.error || `HTTP ${r.status}`); return x; };

function live() {
  return {
    mode: 'live',
    devices: () => j('api/devices'),
    scan: () => j('api/scan', { method: 'POST' }),
    add: url => j('api/add', { method: 'POST', body: { url } }),
    forget: id => j('api/forget', { method: 'POST', body: { id } }),
    setConfig: (id, patch) => j(`api/dev/${id}/config`, { method: 'PUT', body: patch }),
    action: (id, a) => j(`api/dev/${id}/action`, { method: 'POST', body: a }),
    frame: async id => unpack(await j(`api/dev/${id}/frame`)),
  };
}
function demo() {
  let fleet = demoFleet(true), last = performance.now();
  setInterval(() => { const now = performance.now(), dt = Math.min(0.2, (now - last) / 1000); last = now; for (const d of fleet) d.tick(dt); }, 50);
  // the Virtual DMX cable of the other Wincode programs (same browser, same site): what they send drives the demo fleet
  try { new BroadcastChannel('wmh-dmx').onmessage = e => { const m = e.data; if (m && m.t === 'dmx' && m.data) { const d = Uint8Array.from(m.data); for (const x of fleet) x.feed(m.u ?? 0, d, true, 'Virtual DMX cable'); } }; } catch (e) {}
  const get = id => { const d = fleet.find(x => x.id === id); if (!d) throw new Error('unknown device'); return d; };
  return {
    mode: 'demo',
    devices: async () => fleet.map((d, i) => ({ id: d.id, url: `demo://node-${i + 1}`, online: !(d.bootAt && d.t < d.bootAt), seen: Date.now(), info: d.info(), config: d.config(), status: d.status() })),
    scan: async () => ({ ok: true }),
    add: async () => { throw new Error('Adding by address needs the manager server (npm start).'); },
    forget: async id => { fleet = fleet.filter(d => d.id !== id); return { ok: true }; },
    setConfig: async (id, patch) => get(id).setConfig(patch),
    action: async (id, a) => { const r = get(id).action(a); if (!r.ok) throw new Error(r.error); return r; },
    frame: async id => get(id).frame(),
  };
}
export async function connect() {
  try { const r = await fetch('api/ping', { cache: 'no-store' }); if (r.ok && (await r.json()).app === 'wincode-node-manager') return live(); } catch (e) {}
  return demo();
}
