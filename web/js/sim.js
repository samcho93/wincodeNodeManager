// sim.js — the Simulator tab: what the virtual winches and pixel nodes do with the DMX they receive.
//  Winches are drawn as a front view of the rig (drum, cable, the lamp with its pixels, target mark, a ruler in metres);
//  pixel nodes as their strips, one row of LEDs per port. The picture comes from each device's frame (vdevice.js
//  `frame()`), read about 15 times a second — real firmware has no such call, so only virtual devices are shown.
import { h, fill } from './ui.js';

let api = null, getDevs = () => [], timer = 0, raf = 0, built = '', frames = new Map(), busy = false;
const ACC = '#ff8a1f', DIM = '#8a94a2', LINE = '#2a313b';
const rgb = (p, i, k = 1) => `rgb(${Math.min(255, p[i * 3] * k) | 0},${Math.min(255, p[i * 3 + 1] * k) | 0},${Math.min(255, p[i * 3 + 2] * k) | 0})`;
const size = cv => { const r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1), w = Math.max(50, Math.round(r.width * d)), hh = Math.max(50, Math.round(r.height * d)); if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; } return d; };

function drawWinches(cv, list) {
  const d = size(cv), g = cv.getContext('2d'), W = cv.width, H = cv.height; g.fillStyle = '#07090b'; g.fillRect(0, 0, W, H);
  const fs = list.map(x => frames.get(x.id)).filter(Boolean); if (!fs.length) return;
  const top = 46 * d, lamp = 0.6, maxT = Math.max(1000, ...fs.map(f => f.max)) / 1000, bottom = H - 30 * d, scale = (bottom - top - 20 * d) / (maxT + lamp), left = 54 * d, pitch = (W - left - 20 * d) / list.length;
  const y = m => top + 20 * d + m * scale;
  g.font = `${11 * d}px "Segoe UI", sans-serif`; g.textBaseline = 'middle';
  for (let m = 0; m <= maxT + lamp; m += 0.5) { g.strokeStyle = m % 1 ? '#12161b' : '#1b2129'; g.beginPath(); g.moveTo(left - 6 * d, y(m)); g.lineTo(W, y(m)); g.stroke(); if (m % 1 === 0) { g.fillStyle = DIM; g.textAlign = 'right'; g.fillText(`${m} m`, left - 10 * d, y(m)); } }
  g.fillStyle = '#3a424d'; g.fillRect(left - 6 * d, top, W - left, 8 * d);                               // the truss the winches hang on
  g.fillStyle = '#1b2129'; g.fillRect(0, bottom, W, 2 * d);
  list.forEach((dev, i) => {
    const f = frames.get(dev.id), x = left + pitch * (i + 0.5); g.textAlign = 'center';
    g.fillStyle = '#dfe5ec'; g.fillText(dev.config?.name || dev.id, x, 14 * d);
    if (!f) { g.fillStyle = DIM; g.fillText(dev.online ? '…' : 'offline', x, 30 * d); return; }
    const pos = f.position / 1000, n = f.pixels.length / 3;
    g.fillStyle = DIM; g.fillText(`${Math.round(f.position)} mm · ${Math.round(f.speed)} mm/s${f.manual ? ' · manual' : ''}`, x, 30 * d);
    g.fillStyle = '#2a313b'; g.fillRect(x - 22 * d, top + 8 * d, 44 * d, 14 * d); g.fillStyle = '#566170'; g.beginPath(); g.arc(x, top + 15 * d, 6 * d, 0, 6.3); g.fill();   // drum
    g.strokeStyle = '#9aa3ae'; g.lineWidth = d; g.beginPath(); g.moveTo(x, top + 20 * d); g.lineTo(x, y(pos)); g.stroke();                                              // cable
    g.strokeStyle = ACC; g.beginPath(); g.moveTo(x - 30 * d, y(f.target / 1000)); g.lineTo(x - 18 * d, y(f.target / 1000)); g.stroke();                                // where it is going
    g.strokeStyle = '#39414c'; for (const m of [f.min, f.max]) { g.beginPath(); g.moveTo(x + 18 * d, y(m / 1000)); g.lineTo(x + 30 * d, y(m / 1000)); g.stroke(); }     // travel limits
    const w = 12 * d, hh = lamp * scale;
    g.fillStyle = '#15191e'; g.fillRect(x - w / 2 - d, y(pos), w + 2 * d, hh);
    if (n) { let r = 0, gr = 0, b = 0; for (let k = 0; k < n; k++) { r += f.pixels[k * 3]; gr += f.pixels[k * 3 + 1]; b += f.pixels[k * 3 + 2]; }
      g.shadowColor = `rgb(${r / n | 0},${gr / n | 0},${b / n | 0})`; g.shadowBlur = 22 * d * Math.min(1, (r + gr + b) / n / 200);
      for (let k = 0; k < n; k++) { g.fillStyle = rgb(f.pixels, k, 1.15); g.fillRect(x - w / 2, y(pos) + hh * k / n, w, Math.ceil(hh / n) + 0.5); }
      g.shadowBlur = 0; }
  });
}
function drawStrips(cv, dev) {
  const d = size(cv), g = cv.getContext('2d'), W = cv.width, f = frames.get(dev.id); g.fillStyle = '#07090b'; g.fillRect(0, 0, W, cv.height); if (!f) return;
  const cell = 7 * d, perRow = Math.max(10, Math.floor((W - 16 * d) / cell)); let yy = 8 * d;
  g.font = `${11 * d}px "Segoe UI", sans-serif`; g.textBaseline = 'top'; g.textAlign = 'left';
  f.ports.forEach((p, i) => {
    const c = dev.config.ports[i] || {}, n = p.pixels.length / 3;
    g.fillStyle = DIM; g.fillText(`Port ${i + 1} · ${p.enabled ? `${n} px · ${c.chip} · universe ${c.universe}${dev.status?.ports?.[i]?.universes > 1 ? '–' + (c.universe + dev.status.ports[i].universes - 1) : ''}` : 'off'}`, 8 * d, yy); yy += 16 * d;
    for (let k = 0; k < n; k++) { const col = k % perRow, row = Math.floor(k / perRow); g.fillStyle = p.pixels[k * 3] + p.pixels[k * 3 + 1] + p.pixels[k * 3 + 2] > 6 ? rgb(p.pixels, k, 1.1) : '#14181d'; g.fillRect(8 * d + col * cell, yy + row * cell, cell - 2 * d, cell - 2 * d); }
    yy += Math.max(1, Math.ceil(n / perRow)) * cell + 8 * d;
  });
  const want = Math.round(yy / d + 4); if (Math.abs(parseFloat(cv.style.height) - want) > 1) cv.style.height = want + 'px';   // as tall as its strips
}

async function poll() {
  if (busy) return; busy = true;
  try { await Promise.all(getDevs().filter(d => d.online && d.info.virtual && (d.info.type === 'winch' || d.info.type === 'pixel')).map(async d => { try { frames.set(d.id, await api.frame(d.id)); } catch (e) { frames.delete(d.id); } })); } finally { busy = false; }
}
/** build (or keep) the Simulator tab; called again whenever the device list is refreshed */
export function drawSim(pane, A, devs) {
  api = A; getDevs = devs;
  const list = devs().filter(d => d.info.type === 'winch' || d.info.type === 'pixel'), virt = list.filter(d => d.info.virtual), sig = virt.map(d => d.id + d.online).join() + '|' + list.length;
  if (sig !== built) {
    built = sig;
    const winches = virt.filter(d => d.info.type === 'winch'), pix = virt.filter(d => d.info.type === 'pixel'), real = list.length - virt.length;
    fill(pane,
      h('div', { class: 'box' }, h('h4', null, 'Where the DMX comes from'),
        h('p', { class: 'note' }, A.mode === 'live'
          ? 'The virtual nodes on this computer take Art-Net on UDP 6454 — send it to 127.0.0.2 (their own address here; 127.0.0.1 may belong to the fixture simulator) or broadcast it — and sACN on its multicast groups. In DMX Studio: Setup → universe output Art-Net, host 127.0.0.2. Until a console sends a universe, a built-in pattern plays on it.'
          : 'Demo mode: the virtual nodes in this page follow the Virtual DMX cable. Open DMX Studio or the DMX Editor in the same browser, set a universe\'s output to "Virtual DMX cable", and the universes these nodes are set to move them. Until something sends a universe, a built-in pattern plays on it.'),
        real ? h('p', { class: 'note' }, `${real} real device${real > 1 ? 's are' : ' is'} not shown here: a real node drives real outputs, there is nothing to simulate.`) : null),
      winches.length ? h('div', { class: 'box' }, h('h4', null, `Kinetic winches (${winches.length})`, h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'orange mark = target · grey marks = travel limits')), h('canvas', { id: 'simWinch', style: 'width:100%;height:440px;display:block;border-radius:6px' })) : null,
      pix.map(d => h('div', { class: 'box' }, h('h4', null, `${d.config?.name || d.id}`, h('span', { class: 'hint' }, `${d.info.model} · pixel node`)), h('canvas', { dataset: { sim: d.id }, style: 'width:100%;height:120px;display:block;border-radius:6px' }))),
      !virt.length ? h('p', { class: 'note' }, 'No virtual winch or pixel node is in the list. Start the manager with its virtual fleet (npm start) or open the demo.') : null);
  }
  if (!timer) { timer = setInterval(poll, 66); poll(); const loop = () => { raf = requestAnimationFrame(loop); const devsNow = getDevs(), wc = pane.querySelector('#simWinch'); if (wc) drawWinches(wc, devsNow.filter(d => d.info.type === 'winch' && d.info.virtual)); pane.querySelectorAll('canvas[data-sim]').forEach(cv => { const d = devsNow.find(x => x.id === cv.dataset.sim); if (d) drawStrips(cv, d); }); }; loop(); }
}
/** leave the tab: stop reading frames */
export function stopSim() { clearInterval(timer); timer = 0; cancelAnimationFrame(raf); frames.clear(); }
