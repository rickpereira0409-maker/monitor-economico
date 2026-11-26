// Utilitários de interface. Todo texto externo entra via textContent (nunca innerHTML) para evitar XSS.
const SVGNS = 'http://www.w3.org/2000/svg';

export function safeHref(u) {
  if (typeof u !== 'string') return null;
  if (u.startsWith('#') || (u.startsWith('/') && !u.startsWith('//'))) return u;
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null; } catch { return null; }
}

function addKids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'href') { const u = safeHref(v); if (u) el.setAttribute('href', u); }
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  addKids(el, kids);
  return el;
}

export function s(tag, props, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(props || {})) if (v != null) el.setAttribute(k, v);
  addKids(el, kids);
  return el;
}

/** Link para fonte externa: abre em nova aba, sem repassar referência. */
export const ext = (href, text, cls) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);

// ---------- Formatação (sempre em America/Sao_Paulo) ----------
const TZ = 'America/Sao_Paulo';
const dtf = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const dfShort = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });

export const fmtNum = (v, d = 2) => (v == null || !Number.isFinite(+v) ? '—' : (+v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${fmtNum(v, 2)}%`);
export const fmtDT = (iso) => (iso ? dtf.format(new Date(iso)).replace(',', '') : '—');
export const fmtD = (iso) => (iso ? df.format(new Date(iso)) : '—');
export const fmtDShort = (iso) => dfShort.format(new Date(iso));
export const fmtDay = (ymd) => (ymd ? ymd.split('-').reverse().join('/') : '—');

export function ago(iso, now = Date.now()) {
  if (!iso) return '—';
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  if (m < 48 * 60) return `há ${Math.round(m / 60)} h`;
  return `há ${Math.round(m / 1440)} dias`;
}

// ---------- API ----------
async function serverApi(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'monitor', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { window.dispatchEvent(new Event('auth-required')); throw new Error('Sessão expirada'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erro ${res.status}`);
  return j;
}

let impl = serverApi;
export const api = (path, opts) => impl(path, opts);

/** Detecta o modo estático (GitHub Pages: existe mode.json) e troca a API para leitura de arquivos JSON. */
export async function initMode() {
  try {
    const r = await fetch('mode.json', { cache: 'no-store' });
    if (!r.ok || !(await r.json()).static) return false;
    const { createStaticApi } = await import('./static-api.js');
    const storage = { getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } } };
    const fetchJson = async (u) => { const x = await fetch(u, { cache: 'no-cache' }); if (!x.ok) throw new Error(`Dados indisponíveis (${x.status})`); return x.json(); };
    impl = createStaticApi({ fetchJson, storage });
    return true;
  } catch { return false; }
}

// ---------- Gráfico de linha em SVG ----------
export function sparkline(values) {
  const el = s('svg', { class: 'spark', viewBox: '0 0 100 30', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Tendência dos últimos 30 dias' });
  if (values.length < 2) return el;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 26}`).join('');
  el.append(s('path', { d }));
  return el;
}

/** points: [{t, v}]; t é ISO (intradiário) ou 'YYYY-MM-DD'. */
export function lineChart(points, { decimals = 4, intraday = false } = {}) {
  const W = 720, H = 300, m = { l: 62, r: 14, t: 14, b: 30 };
  const wrap = h('div', { class: 'chart-wrap' });
  if (points.length < 2) { wrap.append(h('p', { class: 'muted' }, 'Ainda não há pontos suficientes para o gráfico neste período. O sistema acumula o histórico a cada coleta.')); return wrap; }
  const ts = points.map((p) => (p.t.length === 10 ? Date.parse(`${p.t}T12:00:00-03:00`) : Date.parse(p.t)));
  const vs = points.map((p) => p.v);
  const t0 = ts[0], t1 = ts[ts.length - 1];
  let lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = (hi - lo || Math.abs(hi) * 0.01 || 1) * 0.12; lo -= pad; hi += pad;
  const x = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Gráfico de histórico de cotação' });
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4, yy = y(v);
    svg.append(s('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: yy, y2: yy }), s('text', { class: 'axis', x: m.l - 6, y: yy + 4, 'text-anchor': 'end' }, fmtNum(v, decimals)));
  }
  const lab = (t) => (intraday ? new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t)) : fmtDShort(new Date(t)));
  svg.append(s('text', { class: 'axis', x: m.l, y: H - 8 }, lab(t0)), s('text', { class: 'axis', x: W - m.r, y: H - 8, 'text-anchor': 'end' }, lab(t1)));
  const path = points.map((_, i) => `${i ? 'L' : 'M'}${x(ts[i]).toFixed(1)},${y(vs[i]).toFixed(1)}`).join('');
  svg.append(s('path', { class: 'area', d: `${path}L${x(t1)},${H - m.b}L${x(t0)},${H - m.b}Z` }), s('path', { class: 'line', d: path }));
  const cursor = s('line', { class: 'cursor', y1: m.t, y2: H - m.b, visibility: 'hidden' });
  const dot = s('circle', { class: 'dot', r: 5, visibility: 'hidden' });
  svg.append(cursor, dot);
  const tip = h('div', { class: 'tip', hidden: true });
  wrap.append(svg, tip);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    ts.forEach((t, i) => { const d = Math.abs(x(t) - px); if (d < bd) { bd = d; best = i; } });
    const cx = x(ts[best]), cy = y(vs[best]);
    cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.textContent = `${lab(ts[best])} — R$ ${fmtNum(vs[best], decimals)}`;
    tip.style.left = `${(cx / W) * r.width}px`; tip.style.top = `${(cy / H) * r.height}px`;
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerleave', () => { cursor.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  return wrap;
}

/** Substitui os filhos de `el`, ignorando null/false e achatando arrays (replaceChildren/append nativos escreveriam "null"). */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}
