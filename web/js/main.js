// main.js — Wincode Node Manager: find the devices, configure them, commission a rig, watch it run.
//  Devices are the source of truth: the page reads them once a second and writes a change only when you press Apply.
import { connect } from './api.js';
import { TYPES, CHIPS, ORDERS, PATTERNS, universesOf, pixelUniverses, pixelChannels } from './vdevice.js';
import { h, $, fill, btn, select, numInput, textInput, dialog, toast } from './ui.js';

const api = await connect();
const S = { devs: [], sel: null, checked: new Set(), tab: 'devices', log: [], prev: new Map(), draft: null, draftOf: null, dirty: false };
window.WNM = { api, S };                                       // for debugging from the console
const dev = id => S.devs.find(d => d.id === id);
const uptime = s => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`);
const logEv = (text, cls = '') => { S.log.unshift({ at: new Date().toLocaleTimeString('en-GB'), text, cls }); if (S.log.length > 400) S.log.pop(); };
const run = async (fn, okText) => { try { const r = await fn(); if (okText) toast(okText); await refresh(true); return r; } catch (e) { toast(e.message, true); logEv(`Error: ${e.message}`, 'bad'); } };
const tempBar = t => h('div', { class: 'bar ' + (t > 75 ? 'r' : t > 60 ? 'y' : 'g') }, h('i', { style: `width:${Math.min(100, t)}%` }));

/* ── device list ── */
function drawList() {
  const groups = Object.keys(TYPES).map(t => [t, S.devs.filter(d => d.info.type === t)]).filter(g => g[1].length);
  fill($('#list'), h('div', { class: 'row' }, btn('All', () => { S.devs.forEach(d => S.checked.add(d.id)); drawList(); }, 'small'), btn('None', () => { S.checked.clear(); drawList(); }, 'small'),
    h('span', { class: 'note' }, `${S.checked.size} ticked for the commissioning tools`)),
    groups.map(([t, list]) => [h('div', { class: 'note', style: 'margin:8px 0 4px' }, `${TYPES[t].label} · ${list.length}`), list.map(d => {
      const st = d.status || {}, al = (st.alarms || []).length;
      return h('div', { class: `dev t-${t}${d.id === S.sel ? ' sel' : ''}${d.online ? '' : ' off'}`, onclick: () => pick(d.id) },
        h('input', { type: 'checkbox', checked: S.checked.has(d.id), onclick: e => { e.stopPropagation(); e.target.checked ? S.checked.add(d.id) : S.checked.delete(d.id); drawList(); } }),
        h('span', { class: 'ic' }, TYPES[t].icon),
        h('div', { style: 'min-width:0' }, h('div', { class: 'nm' }, d.config?.name || d.info.name), h('div', { class: 'sub' }, `${d.info.model} · ${d.url.replace(/^https?:\/\//, '')}`)),
        h('div', { class: 'st' }, h('span', { class: 'dot ' + (!d.online ? 'bad' : al ? 'warn' : 'ok') }), d.online ? (al ? `${al} alarm${al > 1 ? 's' : ''}` : 'OK') : 'offline', h('br'), d.online ? `${st.tempC} °C` : ''));
    })]),
    !S.devs.length && h('p', { class: 'note' }, 'No devices found yet. Press Scan, or add one by its address.'));
}
function pick(id) { if (S.dirty && !confirm('Discard the changes you have not applied?')) return; S.sel = id; S.draft = null; S.dirty = false; drawList(); drawDetail(); }

/* ── detail: status (redrawn every second) + configuration (redrawn only when it changes) ── */
function statusBox(d) {
  const s = d.status || {}, t = d.info.type, kv = (v, label) => h('div', null, h('b', null, v), h('span', null, label));
  const cells = [kv(d.online ? (s.rebooting ? 'rebooting' : 'online') : 'offline', 'state'), kv(`${s.tempC ?? '—'} °C`, 'temperature'), kv(`${s.vin ?? '—'} V`, 'supply'), kv(uptime(s.uptime || 0), 'uptime')];
  if (t === 'winch') cells.push(kv(`${s.position} mm`, 'position'), kv(`${s.target} mm`, 'target'), kv(`${s.speed} mm/s`, 'speed'), kv(`${s.load} %`, 'load'), kv(s.homed ? 'yes' : 'no', 'homed'), kv(`${s.dmx?.fps ?? 0} Hz`, 'DMX in'));
  if (t === 'hub') cells.push(kv(s.playback?.state || 'idle', 'playback'), kv(s.playback?.preset ? `#${s.playback.preset} · ${s.playback.t}s` : '—', 'preset'), kv(`${((s.storage?.used || 0) / 1e6).toFixed(0)} MB`, 'recorded'));
  return h('div', null, h('div', { class: 'kv' }, cells),
    (t === 'edmx' || t === 'pixel') && h('table', { style: 'margin-top:8px' }, h('thead', null, h('tr', null, ['Port', 'Universe', 'Frames', 'Level', t === 'pixel' ? 'Current' : '', 'Test'].map(x => h('th', null, x)))),
      h('tbody', null, (s.ports || []).map((p, i) => h('tr', null, h('td', null, i + 1), h('td', null, p.enabled ? (p.universes > 1 ? `${p.universe}–${p.universe + p.universes - 1}` : p.universe) : 'off'),
        h('td', null, h('span', { class: 'dot ' + (!p.enabled ? '' : p.fps > 0 ? 'ok' : 'bad') }), `${p.fps} Hz`), h('td', null, h('div', { class: 'bar' }, h('i', { style: `width:${p.level}%` }))), h('td', null, t === 'pixel' ? `${p.amps} A` : ''), h('td', null, p.test || '—'))))),
    t === 'winch' && d.config && h('div', { class: 'winchbar', title: 'Blue = position, yellow = target' }, h('u', { style: `left:${(s.target - d.config.travel.min) / Math.max(1, d.config.travel.max - d.config.travel.min) * 100}%` }), h('i', { style: `left:${(s.position - d.config.travel.min) / Math.max(1, d.config.travel.max - d.config.travel.min) * 100}%` })),
    t === 'hub' && h('table', { style: 'margin-top:8px' }, h('thead', null, h('tr', null, ['Recording universe', 'Frames', 'Level'].map(x => h('th', null, x)))), h('tbody', null, (s.rx || []).map(r => h('tr', null, h('td', null, r.universe), h('td', null, `${r.fps} Hz`), h('td', null, h('div', { class: 'bar' }, h('i', { style: `width:${r.level}%` }))))))),
    (s.alarms || []).map(a => h('div', { class: 'alarm-line' }, '⚠ ' + a.text)));
}
function drawDetail() {
  const d = dev(S.sel), root = $('#detail');
  if (!d) return fill(root, h('div', { class: 'box' }, h('p', { class: 'note' }, 'Select a device on the left to see its state and change its configuration.')));
  if (!S.draft || S.draftOf !== d.id) { S.draft = JSON.parse(JSON.stringify(d.config || {})); S.draftOf = d.id; S.dirty = false; }
  const c = S.draft, t = d.info.type, touch = () => { S.dirty = true; mark.textContent = '● not applied'; mark.className = 'dirty'; };
  const mark = h('span', { class: S.dirty ? 'dirty' : 'note' }, S.dirty ? '● not applied' : 'in sync with the device');
  const F = (o, k, kind, a, b) => kind === 'bool' ? h('input', { type: 'checkbox', checked: !!o[k], onchange: e => { o[k] = e.target.checked; touch(); } })
    : kind === 'num' ? numInput(o[k], a, b, v => { o[k] = v; touch(); }, { step: Number.isInteger(o[k]) ? 1 : 0.1 }) : Array.isArray(kind) ? select(kind, o[k], v => { o[k] = v; touch(); }) : textInput(o[k] ?? '', v => { o[k] = v; touch(); });
  const act = (a, text) => run(() => api.action(d.id, a), text);
  const hold = (label, dir) => { const b = btn(label, null); b.addEventListener('pointerdown', () => api.action(d.id, { action: 'jog', dir }).catch(() => {})); for (const ev of ['pointerup', 'pointerleave']) b.addEventListener(ev, () => api.action(d.id, { action: 'jog', dir: 0 }).catch(() => {})); return b; };

  const parts = [h('div', { class: 'box' }, h('h4', null, `${TYPES[t].icon} ${TYPES[t].label}`, h('span', { class: 'spacer' }), h('span', { class: 'note' }, `${d.info.model} · ${d.id} · firmware ${d.info.fw} · ${d.url}`)),
    h('div', { class: 'row' }, btn(c.identify ? '◉ Identifying' : 'Identify', () => act({ action: 'identify', on: !d.config.identify }), d.config.identify ? 'on' : '', 'Blink the device so that you can find it in the rig'),
      btn('Reboot', () => confirm(`Reboot “${d.config.name}”?`) && act({ action: 'reboot' }, 'Rebooting')), btn('Factory reset', () => confirm('Reset every setting except the name and the network?') && run(async () => { await api.action(d.id, { action: 'factory' }); S.draft = null; }, 'Factory settings restored'), 'warn'),
      btn('Forget', () => run(async () => { await api.forget(d.id); S.sel = null; }, 'Removed from the list'), '', 'Remove from this list (the device itself is not changed)'),
      api.mode !== 'live' ? null : h('a', { class: 'btn', href: d.url, target: '_blank', title: 'The device\'s own page' }, 'Open device'),
      d.info.virtual && btn('Simulate fault', () => act({ action: 'fault', kind: 'overtemp' }, 'Virtual device: over-temperature'), 'small', 'Virtual devices only'), d.info.virtual && btn('Clear fault', () => act({ action: 'fault', kind: null }), 'small', 'Virtual devices only')),
    h('div', { id: 'liveStatus' }, statusBox(d)))];

  // type-specific controls
  if (t === 'winch') parts.push(h('div', { class: 'box' }, h('h4', null, 'Manual control', h('span', { class: 'note' }, '— for commissioning; DMX takes over again with “Release to DMX”')),
    h('div', { class: 'row' }, btn('Home', () => act({ action: 'home' }, 'Homing')), hold('▲ Up (hold)', -1), hold('▼ Down (hold)', 1), btn('Stop', () => act({ action: 'stop' })), btn('Release to DMX', () => act({ action: 'release' }, 'Following DMX')),
      h('span', null, 'Go to'), numInput(0, 0, 100000, v => act({ action: 'goto', position: v }), { title: 'Position in mm' }), h('span', { class: 'note' }, 'mm'))));
  if (t === 'hub') parts.push(h('div', { class: 'box' }, h('h4', null, 'Presets'),
    h('table', null, h('thead', null, h('tr', null, ['#', 'Name', 'Length s', '', ''].map(x => h('th', null, x)))), h('tbody', null, c.presets.map((p, i) => h('tr', null, h('td', null, p.id), h('td', null, F(p, 'name')), h('td', null, F(p, 'seconds', 'num', 1, 36000)),
      h('td', null, btn('▶ Play', () => act({ action: 'play', preset: p.id }), 'small'), btn('● Record', () => act({ action: 'record', preset: p.id }), 'small', 'Record the incoming universes into this preset'), btn('■', () => act({ action: 'stop' }), 'small')),
      h('td', null, btn('✕', () => { c.presets.splice(i, 1); touch(); drawDetail(); }, 'small')))))),
    h('div', { class: 'row', style: 'margin-top:8px' }, btn('+ Preset', () => { c.presets.push({ id: Math.max(0, ...c.presets.map(p => p.id)) + 1, name: 'Preset', seconds: 10 }); touch(); drawDetail(); }, 'small'),
      h('span', null, 'Start on power-up'), select([[0, 'nothing'], ...c.presets.map(p => [p.id, p.name])], c.onBoot, v => { c.onBoot = +v; touch(); }))));

  // configuration
  const general = h('div', { class: 'form' }, h('span', null, 'Name'), F(c, 'name'), h('span', null, 'DHCP'), F(c.net, 'dhcp', 'bool'), h('span', null, 'IP address'), F(c.net, 'ip'), h('span', null, 'Subnet mask'), F(c.net, 'mask'), h('span', null, 'Gateway'), F(c.net, 'gateway'));
  const tbl = (heads, rows) => h('table', null, h('thead', null, h('tr', null, heads.map(x => h('th', null, x)))), h('tbody', null, rows));
  let specific = null;
  if (t === 'edmx') specific = tbl(['Port', 'On', 'Direction', 'Protocol', 'Universe', 'Merge', 'Rate Hz', 'On signal loss', 'RDM', 'Test'], c.ports.map((p, i) => h('tr', null, h('td', null, i + 1), h('td', null, F(p, 'enabled', 'bool')), h('td', null, F(p, 'dir', [['out', 'Network → DMX'], ['in', 'DMX → network']])),
    h('td', null, F(p, 'protocol', [['artnet', 'Art-Net'], ['sacn', 'sACN']])), h('td', null, F(p, 'universe', 'num', 0, 63999)), h('td', null, F(p, 'merge', [['htp', 'HTP'], ['ltp', 'LTP']])), h('td', null, F(p, 'rate', 'num', 1, 44)),
    h('td', null, F(p, 'onLoss', [['hold', 'Hold last look'], ['blackout', 'Blackout']])), h('td', null, F(p, 'rdm', 'bool')), h('td', null, select(PATTERNS.slice(0, 5), 'off', v => act({ action: 'test', port: i, pattern: v }), { title: 'Send a test level to this port now' })))));
  if (t === 'pixel') specific = [h('div', { class: 'form', style: 'margin-bottom:8px' }, h('span', null, 'Protocol'), F(c, 'protocol', [['artnet', 'Art-Net'], ['sacn', 'sACN']])),
    tbl(['Port', 'On', 'Chip', 'Order', 'Pixels', 'Group', 'Universe', 'Start ch', 'Needs', 'Reverse', 'Limit %', 'Gamma', 'Test'], c.ports.map((p, i) => h('tr', null, h('td', null, i + 1), h('td', null, F(p, 'enabled', 'bool')), h('td', null, F(p, 'chip', Object.keys(CHIPS))), h('td', null, F(p, 'order', ORDERS)),
      h('td', null, F(p, 'pixels', 'num', 0, 4096)), h('td', null, F(p, 'group', 'num', 1, 64)), h('td', null, F(p, 'universe', 'num', 0, 63999)), h('td', null, F(p, 'startChannel', 'num', 1, 512)),
      h('td', { class: 'note' }, `${pixelChannels(p)} ch · ${pixelUniverses(p)} univ.`), h('td', null, F(p, 'reverse', 'bool')), h('td', null, F(p, 'limit', 'num', 1, 100)), h('td', null, F(p, 'gamma', 'num', 1, 3)),
      h('td', null, select(PATTERNS, 'off', v => act({ action: 'test', port: i, pattern: v }))))))];
  if (t === 'winch') specific = h('div', { class: 'form' }, h('span', null, 'Protocol'), F(c, 'protocol', [['artnet', 'Art-Net'], ['sacn', 'sACN']]), h('span', null, 'Universe'), F(c, 'universe', 'num', 0, 63999),
    h('span', null, 'DMX address'), h('div', null, F(c, 'address', 'num', 1, 511), h('span', { class: 'note' }, '  position coarse + fine (2 channels)')),
    h('span', null, 'Travel, top (mm)'), F(c.travel, 'min', 'num', 0, 100000), h('span', null, 'Travel, bottom (mm)'), F(c.travel, 'max', 'num', 0, 100000), h('span', null, 'Maximum speed (mm/s)'), F(c, 'speedMax', 'num', 10, 5000),
    h('span', null, 'Acceleration (mm/s²)'), F(c, 'accel', 'num', 10, 10000), h('span', null, 'Invert direction'), F(c, 'invert', 'bool'), h('span', null, 'On signal loss'), F(c, 'onLoss', [['hold', 'Hold position'], ['home', 'Go home']]),
    h('span', null, 'Pixel output'), F(c.pixel, 'enabled', 'bool'), h('span', null, 'Pixel universe'), F(c.pixel, 'universe', 'num', 0, 63999), h('span', null, 'Pixels'), F(c.pixel, 'pixels', 'num', 0, 1024), h('span', null, 'Pixel chip'), F(c.pixel, 'chip', Object.keys(CHIPS)));
  if (t === 'hub') specific = h('div', { class: 'form' }, h('span', null, 'Record protocol'), F(c.record, 'protocol', [['artnet', 'Art-Net'], ['sacn', 'sACN']]),
    h('span', null, 'Record universes'), textInput(c.record.universes.join(', '), v => { c.record.universes = v.split(/[ ,]+/).map(Number).filter(n => Number.isInteger(n) && n >= 0); touch(); }, { title: 'Comma-separated universe numbers' }),
    h('span', null, 'Trigger inputs'), h('div', null, c.triggers.map(tr => h('div', { class: 'row' }, `Input ${tr.input} starts`, select([[0, 'nothing'], ...c.presets.map(p => [p.id, p.name])], tr.preset, v => { tr.preset = +v; touch(); })))));
  parts.push(h('div', { class: 'box' }, h('h4', null, 'Configuration', h('span', { class: 'spacer' }), mark,
    btn('Revert', () => { S.draft = null; S.dirty = false; drawDetail(); }, 'small'), btn('Apply', () => run(async () => { await api.setConfig(d.id, c); S.draft = null; S.dirty = false; logEv(`Configuration applied to ${c.name}`, 'ok'); }, 'Applied'), 'acc')),
    h('div', { class: 'note', style: 'margin-bottom:6px' }, 'General and network'), general, h('div', { class: 'note', style: 'margin:12px 0 6px' }, TYPES[t].about), specific));
  fill(root, parts);
}

/* ── monitor ── */
function drawMonitor() {
  fill($('#tab-monitor'), h('div', { class: 'cards' }, S.devs.map(d => { const s = d.status || {}, t = d.info.type, al = s.alarms || [];
    return h('div', { class: `card t-${t}${al.length ? ' alarm' : ''}${d.online ? '' : ' off'}`, style: 'cursor:pointer', onclick: () => { S.sel = d.id; S.draft = null; tab('devices'); } },
      h('h5', null, h('span', { class: 'dot ' + (!d.online ? 'bad' : al.length ? 'warn' : 'ok') }), d.config?.name || d.info.name, h('span', { class: 'spacer' }), h('span', { class: 'note' }, d.online ? `${s.tempC} °C` : 'offline')),
      tempBar(s.tempC || 0),
      (t === 'edmx' || t === 'pixel') && h('div', { class: 'ports' }, (s.ports || []).map((p, i) => [h('span', null, `P${i + 1} · U${p.universe}`), h('div', { class: 'bar' }, h('i', { style: `width:${p.enabled ? p.level : 0}%` })), h('span', null, p.enabled ? `${p.fps} Hz` : 'off')])),
      t === 'winch' && d.config && [h('div', { class: 'winchbar' }, h('u', { style: `left:${(s.target - d.config.travel.min) / Math.max(1, d.config.travel.max - d.config.travel.min) * 100}%` }), h('i', { style: `left:${(s.position - d.config.travel.min) / Math.max(1, d.config.travel.max - d.config.travel.min) * 100}%` })),
        h('div', { class: 'note', style: 'margin-top:4px' }, `${s.position} mm → ${s.target} mm · ${s.speed} mm/s · load ${s.load} %`)],
      t === 'hub' && h('div', { class: 'note', style: 'margin-top:6px' }, `Playback: ${s.playback?.state || 'idle'}${s.playback?.preset ? ` · preset ${s.playback.preset} · ${s.playback.t}s` : ''}`),
      al.map(a => h('div', { class: 'alarm-line' }, '⚠ ' + a.text))); })),
    !S.devs.length && h('p', { class: 'note' }, 'No devices.'));
}

/* ── universes ── */
function universeRows() {
  const rows = [];
  for (const d of S.devs) if (d.config) for (const u of universesOf(d.info.type, d.config)) { const st = d.status || {}, p = (st.ports || [])[u.port - 1], fps = p ? p.fps : d.info.type === 'winch' ? (u.what === 'position' ? st.dmx?.fps : st.pixel?.fps) : d.info.type === 'hub' ? (st.rx || []).find(r => r.universe === u.universe)?.fps : 0; rows.push({ ...u, d, fps: fps || 0 }); }
  return rows.sort((a, b) => a.protocol.localeCompare(b.protocol) || a.universe - b.universe);
}
function drawUniverses() {
  const rows = universeRows(), count = new Map(); for (const r of rows) count.set(r.protocol + r.universe, (count.get(r.protocol + r.universe) || 0) + 1);
  fill($('#tab-universes'), h('div', { class: 'box' }, h('h4', null, 'Universe map', h('span', { class: 'spacer' }), h('span', { class: 'note' }, `${new Set(rows.map(r => r.protocol + r.universe)).size} universes in use · ${rows.length} outputs`)),
    h('table', null, h('thead', null, h('tr', null, ['Protocol', 'Universe', 'Device', 'Port', 'Carries', 'Frames', ''].map(x => h('th', null, x)))),
      h('tbody', null, rows.map(r => h('tr', null, h('td', null, r.protocol === 'sacn' ? 'sACN' : 'Art-Net'), h('td', null, h('b', null, r.universe)), h('td', null, r.d.config.name), h('td', null, r.port), h('td', null, r.what),
        h('td', null, h('span', { class: 'dot ' + (r.fps > 0 ? 'ok' : 'bad') }), `${r.fps} Hz`), h('td', { class: 'note' }, count.get(r.protocol + r.universe) > 1 ? `shared by ${count.get(r.protocol + r.universe)} outputs` : ''))))),
    h('p', { class: 'note' }, 'Every universe a device listens to, across the whole rig. Several outputs on one universe is allowed (they show the same data); use it to spot a universe you numbered twice by mistake.')));
}

/* ── commissioning tools ── */
function drawTools() {
  const targets = () => (S.checked.size ? S.devs.filter(d => S.checked.has(d.id)) : S.devs).filter(d => d.online && d.config);
  let start = 0, proto = 'artnet', prefix = 'Node', from = S.sel || (S.devs[0] && S.devs[0].id);
  const each = (fn, text) => run(async () => { let n = 0; for (const d of targets()) { await fn(d, n++); } logEv(`${text}: ${n} devices`, 'ok'); }, text);
  fill($('#tab-tools'),
    h('p', { class: 'note' }, `The tools work on the devices ticked in the Devices list — ${S.checked.size ? S.checked.size + ' ticked' : 'none ticked, so on all ' + S.devs.length}. Changes are written to the devices at once.`),
    h('div', { class: 'box' }, h('h4', null, 'Number the universes'),
      h('div', { class: 'row' }, 'Start at', numInput(start, 0, 63999, v => { start = v; }), 'Protocol', select([['artnet', 'Art-Net'], ['sacn', 'sACN']], proto, v => { proto = v; }),
        btn('Number in list order', () => run(async () => { let u = start, n = 0; for (const d of targets()) { const c = JSON.parse(JSON.stringify(d.config)), t = d.info.type;
          if (t === 'edmx') c.ports.forEach(p => { p.protocol = proto; p.universe = u++; });
          else if (t === 'pixel') { c.protocol = proto; c.ports.forEach(p => { p.universe = u; u += pixelUniverses(p); }); }
          else if (t === 'winch') { c.protocol = proto; c.pixel.universe = u++; } else continue;
          await api.setConfig(d.id, c); n++; } logEv(`Universes numbered ${start}–${u - 1} on ${n} devices`, 'ok'); }, 'Universes numbered'), 'acc')),
      h('p', { class: 'note' }, 'Gives every output its own universe, one after another: an eDMX port takes one, a pixel port as many as its pixel count needs, a winch one for its pixels (its position channels are not moved).')),
    h('div', { class: 'box' }, h('h4', null, 'Name the devices'),
      h('div', { class: 'row' }, 'Prefix', textInput(prefix, v => { prefix = v; }), btn('Rename', () => each((d, i) => api.setConfig(d.id, { name: `${prefix} ${i + 1}` }), 'Renamed'), 'acc'))),
    h('div', { class: 'box' }, h('h4', null, 'Copy a configuration'),
      h('div', { class: 'row' }, 'From', select(S.devs.map(d => [d.id, `${d.config?.name} (${d.info.model})`]), from, v => { from = v; }),
        btn('Copy to the ticked devices of the same model', () => run(async () => { const src = dev(from); if (!src) throw new Error('Choose a device to copy from'); let n = 0;
          for (const d of targets()) { if (d.id === src.id || d.info.model !== src.info.model) continue; const c = JSON.parse(JSON.stringify(src.config)); c.name = d.config.name; c.net = d.config.net; await api.setConfig(d.id, c); n++; }
          logEv(`Configuration of ${src.config.name} copied to ${n} devices`, 'ok'); if (!n) throw new Error('No other ticked device of that model'); }, 'Copied'), 'acc')),
      h('p', { class: 'note' }, 'Everything except the name and the network settings.')),
    h('div', { class: 'box' }, h('h4', null, 'Find and restart'),
      h('div', { class: 'row' }, btn('Identify on', () => each(d => api.action(d.id, { action: 'identify', on: true }), 'Identifying')), btn('Identify off', () => each(d => api.action(d.id, { action: 'identify', on: false }), 'Identify off')),
        btn('Reboot', () => confirm('Reboot the devices?') && each(d => api.action(d.id, { action: 'reboot' }), 'Rebooting'), 'warn'))),
    h('div', { class: 'box' }, h('h4', null, 'Backup and restore'),
      h('div', { class: 'row' }, btn('Download backup', () => { const data = { app: 'wincode-node-manager', saved: new Date().toISOString(), devices: targets().map(d => ({ id: d.id, model: d.info.model, type: d.info.type, config: d.config })) };
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })); a.download = `wincode-nodes-${data.saved.slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(a.href); logEv(`Backup of ${data.devices.length} devices downloaded`, 'ok'); }),
        btn('Restore from a backup…', () => $('#fileRestore').click()), h('input', { type: 'file', id: 'fileRestore', accept: '.json', hidden: true, onchange: async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return;
          run(async () => { const data = JSON.parse(await f.text()); if (data.app !== 'wincode-node-manager') throw new Error('Not a Node Manager backup'); let n = 0, miss = 0;
            for (const b of data.devices) { const d = dev(b.id); if (!d || d.info.model !== b.model) { miss++; continue; } await api.setConfig(d.id, b.config); n++; } logEv(`Backup restored to ${n} devices${miss ? `, ${miss} not found` : ''}`, miss ? 'bad' : 'ok'); toast(`Restored ${n} devices${miss ? ` · ${miss} not on the network` : ''}`, !!miss); }); } })),
      h('p', { class: 'note' }, 'A backup holds the full configuration of each device, matched by its ID when restored. Replace a broken node, give the new one the old one\'s settings.')));
}
function drawLog() { fill($('#tab-log'), h('div', { class: 'box' }, h('h4', null, 'Event log', h('span', { class: 'spacer' }), btn('Clear', () => { S.log.length = 0; drawLog(); }, 'small')), h('div', { class: 'log' }, S.log.map(l => h('div', { class: l.cls }, `${l.at}  ${l.text}`)), !S.log.length && h('p', { class: 'note' }, 'Nothing yet.')))); }

/* ── shell ── */
const DRAW = { devices: () => { drawList(); drawDetail(); }, monitor: drawMonitor, universes: drawUniverses, tools: drawTools, log: drawLog };
function tab(name) { S.tab = name; document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name)); document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name)); DRAW[name](); }
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => tab(t.dataset.tab)));
$('#btnScan').addEventListener('click', () => run(() => api.scan(), 'Scanning…'));
$('#btnAdd').addEventListener('click', () => { let url = ''; dialog('Add a device by address', b => fill(b, h('div', { class: 'form' }, h('span', null, 'Address'), textInput('', v => { url = v; }, { placeholder: '192.168.1.60  or  http://192.168.1.60:80' })),
  h('p', { class: 'note' }, 'For a device on another subnet, where the discovery broadcast does not reach.')), [['Add', () => { run(() => api.add(url), 'Device added'); }, 'acc']]); });
if (api.mode !== 'live') $('#lnkSpec').href = 'https://github.com/samcho93/wincodeNodeManager/blob/main/docs/DEVICE-API.md';

async function refresh(force) {
  let list; try { list = await api.devices(); } catch (e) { $('#modePill').className = 'pill off'; $('#modePill').textContent = 'Manager server not reachable'; return; }
  for (const d of list) { const p = S.prev.get(d.id), al = (d.status?.alarms || []).map(a => a.code).join();
    if (!p) logEv(`Found ${d.info.model} “${d.info.name}” at ${d.url}`, 'ok'); else { if (p.online !== d.online) logEv(`${d.config?.name || d.id} is ${d.online ? 'back online' : 'offline'}`, d.online ? 'ok' : 'bad'); if (p.al !== al) logEv(al ? `${d.config?.name}: ${d.status.alarms.map(a => a.text).join(' · ')}` : `${d.config?.name}: alarms cleared`, al ? 'bad' : 'ok'); }
    S.prev.set(d.id, { online: d.online, al }); }
  S.devs = list.sort((a, b) => a.info.type.localeCompare(b.info.type) || (a.config?.name || '').localeCompare(b.config?.name || '', undefined, { numeric: true }));
  if (!S.sel && S.devs.length) S.sel = S.devs[0].id;
  const on = S.devs.filter(d => d.online).length, alarms = S.devs.reduce((n, d) => n + (d.online ? (d.status?.alarms || []).length : 0), 0), off = S.devs.length - on;
  $('#modePill').className = 'pill ' + (api.mode === 'live' ? 'on' : 'warn'); $('#modePill').textContent = api.mode === 'live' ? 'Live · manager server' : 'Demo · virtual devices in this page';
  $('#countPill').className = 'pill ' + (off ? 'off' : 'on'); $('#countPill').textContent = `${on} / ${S.devs.length} online`;
  $('#alarmPill').className = 'pill ' + (alarms ? 'off' : 'on'); $('#alarmPill').textContent = alarms ? `${alarms} alarm${alarms > 1 ? 's' : ''}` : 'No alarms';
  if (S.tab === 'devices') { drawList(); const d = dev(S.sel), ls = $('#liveStatus'); if (force || !ls || !d || (!S.dirty && document.activeElement && !$('#detail').contains(document.activeElement) && JSON.stringify(d.config) !== JSON.stringify(S.draft))) { if (!S.dirty) S.draft = null; drawDetail(); } else fill(ls, statusBox(d)); }
  else if (S.tab !== 'tools' || force) DRAW[S.tab]();
}
await refresh(true); setInterval(() => refresh(false), 1000);
