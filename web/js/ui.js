// ui.js — small DOM helpers shared by the views
/** h('div', { class: 'x', onclick: fn, dataset: {…} }, child, 'text', [more]) — null / false children are skipped */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list') el[k] = v; else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export const fill = (el, ...kids) => { el.replaceChildren(); for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k))); return el; };
export const select = (opts, value, onchange, props = {}) => {
  const el = h('select', { ...props, onchange: e => onchange && onchange(e.target.value) }, opts.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return h('option', { value: String(v) }, t); }));
  el.value = String(value ?? ''); return el;
};
export const numInput = (value, min, max, onchange, props = {}) => h('input', { type: 'number', min, max, value, ...props, onchange: e => { const v = Math.min(max, Math.max(min, +e.target.value || 0)); e.target.value = v; onchange(v); } });
export const textInput = (value, onchange, props = {}) => h('input', { type: 'text', value, ...props, onchange: e => onchange(e.target.value) });
/** seconds field bound to a millisecond value */
export const secInput = (ms, onchange, props = {}) => h('input', { type: 'number', min: 0, max: 3600, step: 0.1, value: ((ms || 0) / 1000).toFixed(1), style: 'width:64px', ...props, onchange: e => onchange(Math.round((+e.target.value || 0) * 1000)) });
export const btn = (label, onclick, cls = '', title = '') => h('button', { class: 'btn ' + cls, onclick, title }, label);
export const fmtTime = ms => { const s = Math.max(0, ms) / 1000, m = Math.floor(s / 60); return `${String(m).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
export const pct = v => Math.round(v / 2.55) + '%';

/** Modal dialog. build(body, close) fills it; returns the close function */
export function dialog(title, build, buttons = []) {
  const back = h('div', { class: 'dlg-back' }), close = () => back.remove(), body = h('div', { class: 'dlg-body' });
  const box = h('div', { class: 'dlg' }, h('h3', null, title), body, h('div', { class: 'btns' }, buttons.map(([label, fn, cls]) => btn(label, () => { if (fn() !== false) close(); }, cls)), btn('Close', close)));
  back.append(box); back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  build(body, close); document.body.append(back); return close;
}
/** short message at the bottom of the window */
export function toast(text, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, text); document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10); setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}
export const hsv = (hh, s, v) => { const f = n => { const k = (n + hh * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)].map(x => Math.round(x * 255)); };
