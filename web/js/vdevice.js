// vdevice.js — the device model: what a Wincode node is, what it can be told and what it reports.
//  One class plays every device type. It is used three ways:
//   · in the browser, as the demo fleet when no manager server is running;
//   · in Node, behind the HTTP API of the virtual devices (server/virtual.mjs);
//   · as the executable reference for the firmware — docs/DEVICE-API.md describes exactly what this file does.
//  Pure logic: no network, no DOM, no timers. The host calls tick(dt) and feed(universe, data).

export const API_VERSION = 1;
export const TYPES = {
  edmx: { label: 'eDMX node', icon: '⇄', about: 'Art-Net / sACN to DMX512 ports, with merge, reroute and signal-loss behaviour' },
  pixel: { label: 'Pixel node', icon: '▦', about: 'Art-Net / sACN to addressable LED pixels' },
  hub: { label: 'Hub', icon: '◉', about: 'Supervises nodes, records DMX and plays it back as presets' },
  winch: { label: 'Kinetic winch', icon: '⇵', about: 'Motorised winch driven by a 16-bit DMX position, with a pixel output' },
};
export const MODELS = {
  'WN-DMX2': { type: 'edmx', ports: 2 }, 'WN-DMX4': { type: 'edmx', ports: 4 }, 'WN-DMX8': { type: 'edmx', ports: 8 },
  'WN-PIX4': { type: 'pixel', ports: 4 }, 'WN-PIX8': { type: 'pixel', ports: 8 },
  'WN-HUB': { type: 'hub', ports: 0 }, 'WN-WINCH': { type: 'winch', ports: 1 },
};
export const CHIPS = { WS2812B: 3, WS2811: 3, SK6812: 3, 'SK6812-RGBW': 4, APA102: 3, UCS2903: 3 };
export const ORDERS = ['GRB', 'RGB', 'BRG', 'RBG', 'GBR', 'BGR', 'GRBW', 'RGBW'];
export const PATTERNS = ['off', 'red', 'green', 'blue', 'white', 'chase', 'rainbow'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** DMX channels one pixel port needs, and how many universes that is (510 usable channels per universe keep pixels whole) */
export const pixelChannels = p => Math.ceil((p.pixels || 0) / Math.max(1, p.group || 1)) * (CHIPS[p.chip] || 3);
export const pixelUniverses = p => Math.max(1, Math.ceil(pixelChannels(p) / (Math.floor(510 / (CHIPS[p.chip] || 3)) * (CHIPS[p.chip] || 3))));
/** universes a device listens to: [{ universe, protocol, port, what }] */
export function universesOf(type, cfg) {
  const out = [];
  if (type === 'edmx') cfg.ports.forEach((p, i) => { if (p.enabled) out.push({ universe: p.universe, protocol: p.protocol, port: i + 1, what: p.dir === 'in' ? 'DMX in' : 'DMX out' }); });
  if (type === 'pixel') cfg.ports.forEach((p, i) => { if (p.enabled) for (let k = 0; k < pixelUniverses(p); k++) out.push({ universe: p.universe + k, protocol: cfg.protocol, port: i + 1, what: `pixels ${k + 1}/${pixelUniverses(p)}` }); });
  if (type === 'winch') { out.push({ universe: cfg.universe, protocol: cfg.protocol, port: 1, what: 'position' }); if (cfg.pixel.enabled) out.push({ universe: cfg.pixel.universe, protocol: cfg.protocol, port: 1, what: 'pixels' }); }
  if (type === 'hub') cfg.record.universes.forEach(u => out.push({ universe: u, protocol: cfg.record.protocol, port: '—', what: 'recording input' }));
  return out;
}

export function defaultConfig(model, index = 0) {
  const M = MODELS[model], net = { dhcp: true, ip: `192.168.1.${50 + index}`, mask: '255.255.255.0', gateway: '192.168.1.1' };
  const base = { name: `${model} ${index + 1}`, net, identify: false };
  switch (M.type) {
    case 'edmx': return { ...base, ports: Array.from({ length: M.ports }, (_, i) => ({ enabled: true, dir: 'out', protocol: 'artnet', universe: i, merge: 'htp', rate: 40, onLoss: 'hold', rdm: true })), reroute: [] };
    case 'pixel': return { ...base, protocol: 'artnet', ports: Array.from({ length: M.ports }, (_, i) => ({ enabled: true, chip: 'WS2812B', order: 'GRB', pixels: 170, universe: i, startChannel: 1, group: 1, reverse: false, limit: 100, gamma: 2.2 })) };
    case 'hub': return { ...base, record: { protocol: 'artnet', universes: [0, 1] }, presets: [{ id: 1, name: 'Preset 1', seconds: 12 }, { id: 2, name: 'Preset 2', seconds: 30 }], triggers: [{ input: 1, preset: 1 }, { input: 2, preset: 2 }], onBoot: 0 };
    case 'winch': return { ...base, protocol: 'artnet', universe: 0, address: 1 + index * 4, travel: { min: 0, max: 5000 }, speedMax: 800, accel: 600, invert: false, onLoss: 'hold', pixel: { enabled: true, universe: 10 + index, pixels: 60, chip: 'WS2812B' } };
  }
}
/** deep merge of a config patch; arrays are merged element by element (a patch may carry only the changed ports) */
export function merge(dst, src) {
  if (Array.isArray(src)) { if (!Array.isArray(dst) || src.some(x => x === null || typeof x !== 'object')) return src.slice(); const out = dst.slice(); src.forEach((v, i) => { out[i] = v === undefined ? out[i] : merge(out[i] ?? {}, v); }); return out; }
  if (src && typeof src === 'object') { const out = { ...(dst && typeof dst === 'object' ? dst : {}) }; for (const [k, v] of Object.entries(src)) out[k] = merge(out[k], v); return out; }
  return src;
}

export class VDevice {
  constructor({ id, model, index = 0, sim = true, fw = '1.0.3' }) {
    this.id = id; this.model = model; this.type = MODELS[model].type; this.fw = fw; this.sim = sim;
    this.cfg = defaultConfig(model, index);
    this.up = 0; this.temp = 34 + (index % 5); this.vin = 24 - (index % 3) * 0.2; this.t = 0; this.bootAt = 0; this.fault = null; this.pattern = {};
    this.rx = new Map();                                        // universe → { n, last, level, real }
    this.pos = 0; this.target = 0; this.vel = 0; this.homed = false; this.jog = null;
    this.play = { state: 'idle', preset: 0, t: 0 }; this.events = [];
  }
  info() { return { api: API_VERSION, id: this.id, type: this.type, model: this.model, name: this.cfg.name, fw: this.fw, hw: 'A', ports: MODELS[this.model].ports, virtual: true }; }
  config() { return JSON.parse(JSON.stringify(this.cfg)); }
  setConfig(patch) { this.cfg = merge(this.cfg, patch); return this.config(); }
  /** a received DMX frame (real traffic); the simulator's own traffic stops for that universe for two seconds */
  feed(universe, data, real = true) { let r = this.rx.get(universe); if (!r) this.rx.set(universe, r = { n: 0, fps: 0, level: 0, real: 0, data: null }); r.n++; r.data = data; if (real) r.real = this.t; let s = 0; for (let i = 0; i < data.length; i += 8) s += data[i]; r.level = s / (data.length / 8) / 255; }
  tick(dt) {                                                    // dt in seconds
    this.t += dt; this.up += dt;
    if (this.bootAt && this.t < this.bootAt) return; this.bootAt = 0;
    const used = universesOf(this.type, this.cfg);
    if (this.sim) { this._acc = (this._acc || 0) + dt; while (this._acc >= 0.025) { this._acc -= 0.025;               // stand-in controller: 40 frames a second
      for (const u of new Set(used.map(x => x.universe))) { const r = this.rx.get(u); if (r && this.t - r.real < 2) continue; const d = new Uint8Array(512), ph = this.t * 0.6 + u; for (let i = 0; i < 512; i++) d[i] = 128 + 127 * Math.sin(ph + i * 0.05); if (this.type === 'winch' && u === this.cfg.universe) { const v = Math.round((0.5 + 0.5 * Math.sin(this.t * 0.25 + this.cfg.address)) * 65535); d[this.cfg.address - 1] = v >> 8; d[this.cfg.address] = v & 255; } this.feed(u, d, false); } } }
    this._s = (this._s || 0) + dt; if (this._s >= 1) { for (const r of this.rx.values()) { r.fps = Math.round(r.n / this._s); r.n = 0; } this._s = 0; }
    let load = 0.2;
    if (this.type === 'winch') {
      const c = this.cfg, r = this.rx.get(c.universe), span = c.travel.max - c.travel.min;
      if (this.jog != null) this.target = clamp(this.target + this.jog * c.speedMax * 0.4 * dt, c.travel.min, c.travel.max);
      else if (r && r.fps > 0 && r.data) { let k = ((r.data[c.address - 1] << 8) | r.data[c.address]) / 65535; if (c.invert) k = 1 - k; this.target = c.travel.min + k * span; }
      const d = this.target - this.pos, stop = (this.vel * this.vel) / (2 * c.accel), want = Math.abs(d) < 0.5 ? 0 : Math.sign(d) * (Math.abs(d) <= stop ? Math.max(20, Math.abs(this.vel) - c.accel * dt) : c.speedMax);
      this.vel += clamp(want - this.vel, -c.accel * dt, c.accel * dt); if (this.fault === 'stall') this.vel = 0;
      if (Math.abs(d) < 3 && Math.abs(this.vel) < 80) { this.pos = this.target; this.vel = 0; }       // settle instead of hunting around the target
      this.pos = clamp(this.pos + this.vel * dt, c.travel.min, c.travel.max); load = 0.25 + Math.abs(this.vel) / c.speedMax * 0.6;
    }
    if (this.type === 'pixel') load = 0.2 + 0.7 * (used.length ? [...this.rx.values()].reduce((s, r) => s + r.level, 0) / Math.max(1, this.rx.size) : 0);
    if (this.type === 'hub' && this.play.state !== 'idle') { this.play.t += dt; const p = this.cfg.presets.find(x => x.id === this.play.preset); if (this.play.state === 'play' && p && this.play.t >= p.seconds) this.play.t = 0; }
    const goal = (this.fault === 'overtemp' ? 86 : 32) + load * 26;
    this.temp += (goal - this.temp) * Math.min(1, dt * 0.08);
  }
  alarms() {
    const a = [];
    if (this.temp > 75) a.push({ code: 'overtemp', text: `Temperature ${this.temp.toFixed(0)} °C` });
    if (this.vin < 20) a.push({ code: 'undervolt', text: `Supply ${this.vin.toFixed(1)} V` });
    if (this.fault === 'stall') a.push({ code: 'stall', text: 'Motor stalled' });
    if (this.type !== 'hub') for (const u of universesOf(this.type, this.cfg)) { const r = this.rx.get(u.universe); if ((!r || r.fps === 0) && u.what !== 'DMX in') { a.push({ code: 'nodata', text: `No data on universe ${u.universe}` }); break; } }
    return a;
  }
  status() {
    const c = this.cfg, rxOf = u => { const r = this.rx.get(u); return r ? { fps: r.fps, level: Math.round(r.level * 100) } : { fps: 0, level: 0 }; };
    const s = { id: this.id, uptime: Math.round(this.up), tempC: Math.round(this.temp * 10) / 10, vin: Math.round(this.vin * 10) / 10, heap: 180000 - Math.round(this.up % 60) * 40, rebooting: !!this.bootAt,
      net: { ip: c.net.ip, link: '100M', rssi: null }, identify: !!c.identify, alarms: this.bootAt ? [] : this.alarms() };
    if (this.type === 'edmx') s.ports = c.ports.map((p, i) => ({ ...rxOf(p.universe), enabled: p.enabled, universe: p.universe, test: this.pattern[i] || null }));
    if (this.type === 'pixel') s.ports = c.ports.map((p, i) => { const r = rxOf(p.universe); return { ...r, enabled: p.enabled, universe: p.universe, universes: pixelUniverses(p), pixels: p.pixels, amps: Math.round(p.pixels * (CHIPS[p.chip] || 3) * 0.02 * (r.level / 100) * (p.limit / 100) * 10) / 10, test: this.pattern[i] || null }; });
    if (this.type === 'winch') Object.assign(s, { position: Math.round(this.pos), target: Math.round(this.target), speed: Math.round(this.vel), moving: Math.abs(this.vel) > 1, homed: this.homed, load: Math.round((0.25 + Math.abs(this.vel) / c.speedMax * 0.6) * 100), dmx: rxOf(c.universe), pixel: c.pixel.enabled ? rxOf(c.pixel.universe) : null });
    if (this.type === 'hub') Object.assign(s, { playback: { ...this.play, t: Math.round(this.play.t * 10) / 10 }, storage: { used: c.presets.reduce((x, p) => x + p.seconds * 44 * 512 * c.record.universes.length, 0), total: 4e9 }, rx: c.record.universes.map(u => ({ universe: u, ...rxOf(u) })) });
    return s;
  }
  /** commands: returns { ok } or { ok: false, error } */
  action(a) {
    const c = this.cfg;
    switch (a.action) {
      case 'identify': c.identify = a.on !== false; return { ok: true };
      case 'reboot': this.bootAt = this.t + 4; this.up = 0; this.rx.clear(); this.pattern = {}; return { ok: true };
      case 'factory': { const name = c.name, net = c.net; this.cfg = defaultConfig(this.model, 0); this.cfg.net = net; this.cfg.name = a.keepName === false ? this.cfg.name : name; return { ok: true }; }
      case 'test': if (!PATTERNS.includes(a.pattern)) return { ok: false, error: 'unknown pattern' }; if (a.pattern === 'off') delete this.pattern[a.port | 0]; else this.pattern[a.port | 0] = a.pattern; return { ok: true };
      case 'home': if (this.type !== 'winch') break; this.jog = null; this.target = c.travel.min; this.homed = true; return { ok: true };
      case 'jog': if (this.type !== 'winch') break; this.jog = clamp(+a.dir || 0, -1, 1) || null; return { ok: true };
      case 'goto': if (this.type !== 'winch') break; this.jog = 0; this.target = clamp(+a.position || 0, c.travel.min, c.travel.max); return { ok: true };
      case 'stop': if (this.type === 'winch') { this.jog = 0; this.target = this.pos; } if (this.type === 'hub') this.play = { state: 'idle', preset: 0, t: 0 }; return { ok: true };
      case 'release': if (this.type !== 'winch') break; this.jog = null; return { ok: true };   // back to DMX control
      case 'play': case 'record': if (this.type !== 'hub') break; { const p = c.presets.find(x => x.id === +a.preset); if (!p) return { ok: false, error: 'no such preset' }; this.play = { state: a.action, preset: p.id, t: 0 }; return { ok: true }; }
      case 'fault': this.fault = a.kind || null; return { ok: true };                              // virtual devices only: overtemp | stall | null
    }
    return { ok: false, error: `action "${a.action}" is not supported by a ${this.type}` };
  }
}

/** the fleet the virtual devices and the browser demo start with */
export function demoFleet(sim = true) {
  const list = [['WN-DMX4', 'Stage left DMX'], ['WN-DMX2', 'FOH DMX'], ['WN-PIX4', 'Truss pixels A'], ['WN-PIX4', 'Truss pixels B'], ['WN-HUB', 'Show hub'], ['WN-WINCH', 'Winch 1'], ['WN-WINCH', 'Winch 2'], ['WN-WINCH', 'Winch 3']];
  return list.map(([model, name], i) => { const d = new VDevice({ id: 'WN' + (0xA1B200 + i * 0x111).toString(16).toUpperCase(), model, index: i, sim }); d.cfg.name = name;
    if (d.type === 'edmx') d.cfg.ports.forEach((p, k) => { p.universe = i * 4 + k; }); if (d.type === 'pixel') d.cfg.ports.forEach((p, k) => { p.universe = 20 + (i - 2) * 8 + k * 2; p.pixels = 300; });
    if (d.type === 'winch') { d.cfg.universe = 40; d.cfg.address = 1 + (i - 5) * 4; d.cfg.pixel.universe = 41 + (i - 5); } return d; });
}
