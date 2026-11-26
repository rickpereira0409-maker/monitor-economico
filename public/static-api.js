// Modo estático (GitHub Pages): o painel lê arquivos JSON gerados pelo coletor em vez de chamar uma API.
// Tudo aqui é lógica pura (sem DOM) para poder ser testada em Node.
const TZ = 'America/Sao_Paulo';
const READ_ONLY = 'Somente leitura nesta versão: edite config/settings.json no GitHub e aguarde a próxima coleta (até ~15 min).';
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '-');

export function pctChange(cur, prev) {
  if (cur == null || prev == null || !Number.isFinite(+cur) || !Number.isFinite(+prev) || +prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

/** Mercado cambial interbancário (9h–17h em dias úteis, horário de Brasília; feriados não considerados). */
export function marketStatusClient(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  const mins = +p.hour * 60 + +p.minute, weekday = !['Sat', 'Sun'].includes(p.weekday);
  const open = weekday && mins >= 540 && mins < 1020;
  return { open, label: open ? 'Mercado aberto' : 'Mercado fechado', reason: open ? 'Mercado interbancário brasileiro aberto (9h às 17h, dias úteis).' : weekday ? 'Fora do horário do mercado interbancário (9h às 17h).' : 'Fim de semana: mercado interbancário fechado.' };
}

export function filterNews(items, q, favSet) {
  let out = items;
  if (q.level) out = out.filter((n) => n.level === q.level);
  if (q.direction) out = out.filter((n) => n.direction === q.direction);
  if (q.topic) out = out.filter((n) => n.topics.includes(q.topic));
  if (q.official === '1') out = out.filter((n) => n.official);
  if (q.q) { const t = q.q.toLowerCase(); out = out.filter((n) => `${n.title} ${n.summary || ''}`.toLowerCase().includes(t)); }
  if (q.favorites === '1') out = out.filter((n) => favSet.has(`news:${n.id}`));
  return out.slice(0, 200);
}

function matchList(list, wanted, all) {
  if (!wanted) return 'sim';
  if (!list || !list.length || list.includes('indeterminado')) return 'indeterminado';
  return list.some((x) => all.includes(x) || x === wanted) ? 'sim' : 'nao';
}

export function filterLegis(items, q, favSet) {
  const out = [];
  for (const it of items) {
    const a = [matchList(it.regimes, q.regime, ['todos']), matchList(it.setores, q.setor, ['todos']), matchList(it.ufs, q.uf, ['todas'])];
    const applies = a.includes('nao') ? 'nao' : a.includes('indeterminado') ? 'indeterminado' : 'sim';
    if (applies === 'nao') continue;
    if (applies === 'indeterminado' && q.hideUndetermined === '1') continue;
    if (q.stage && it.stage !== q.stage) continue;
    if (q.onlyCurated === '1' && !it.curated) continue;
    if (q.favorites === '1' && !favSet.has(`legis:${it.id}`)) continue;
    out.push({ ...it, applies, favorite: favSet.has(`legis:${it.id}`) });
  }
  return out;
}

/** Aplica cotações ao vivo (AwesomeAPI, consultadas pelo próprio navegador) sobre os dados gerados pelo coletor. */
export function applyLive(data, live, nowMs = Date.now()) {
  let n = 0;
  for (const c of data.currencies) {
    if (!c.active) continue;
    for (const t of c.types || []) {
      if (!t.available || t.type === 'ptax') continue;
      const q = live?.[`${c.code}BRL${t.type === 'turismo' ? 'T' : ''}`];
      const value = q ? (t.type === 'turismo' ? +q.ask : +q.bid) : NaN;
      const ts = q ? +q.timestamp * 1000 : 0;
      if (!Number.isFinite(value) || !ts || ts < new Date(t.quoteTs).getTime()) continue;
      t.value = value; t.quoteTs = new Date(ts).toISOString(); t.live = true; t.source = 'AwesomeAPI (consultada agora pelo seu celular)';
      t.changePct = pctChange(value, t.prevClose); t.changeAbs = t.prevClose != null ? value - t.prevClose : null;
      t.stale = false; t.staleNote = null; t.ageMin = Math.max(0, Math.round((nowMs - ts) / 60000));
      n++;
    }
  }
  return n;
}

export function livePairs(data) {
  const out = [];
  for (const c of data.currencies) if (c.active) { out.push(`${c.code}-BRL`); if (c.hasTourism) out.push(`${c.code}-BRLT`); }
  return out;
}

/** Cria a "API" local. fetchJson(url) devolve o JSON ou lança erro; storage tem getItem/setItem. */
export function createStaticApi({ fetchJson, storage }) {
  const read = (k, d) => { try { const v = storage.getItem(`monitor.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const write = (k, v) => { try { storage.setItem(`monitor.${k}`, JSON.stringify(v)); } catch { /* armazenamento indisponível: segue sem persistir */ } };
  const favSet = () => new Set(read('favs', []));
  const file = (name) => fetchJson(`data/${name}`);

  return async function api(path, { method = 'GET', body } = {}) {
    const [p, qs] = path.split('?');
    const q = Object.fromEntries(new URLSearchParams(qs || ''));

    if (method === 'POST' && p === '/favorites') {
      const set = favSet(), key = `${body.kind}:${body.ref}`;
      if (body.on) set.add(key); else set.delete(key);
      write('favs', [...set]); return { ok: true };
    }
    if (method === 'POST' && p === '/alerts/read-all') { const a = await file('alerts.json'); write('read', a.alerts.map((x) => x.id)); return { ok: true }; }
    const rm = /^\/alerts\/(\d+)\/read$/.exec(p);
    if (method === 'POST' && rm) { const s = new Set(read('read', [])); s.add(+rm[1]); write('read', [...s]); return { ok: true }; }
    if (method !== 'GET') throw new Error(READ_ONLY);

    const favs = favSet();
    switch (p) {
      case '/meta': return file('meta.json');
      case '/prefs': return file('prefs.json');
      case '/rules': return file('rules.json');
      case '/agenda': return file('agenda.json');
      case '/favorites': return [...favs].map((k) => ({ kind: k.slice(0, k.indexOf(':')), ref: k.slice(k.indexOf(':') + 1) }));
      case '/status': {
        const s = await file('status.json'), a = await file('alerts.json'), r = new Set(read('read', []));
        return { ...s, now: new Date().toISOString(), market: marketStatusClient(), unreadAlerts: a.alerts.filter((x) => !r.has(x.id)).length };
      }
      case '/alerts': {
        const a = await file('alerts.json'), r = new Set(read('read', []));
        let list = a.alerts.map((x) => ({ ...x, read: r.has(x.id) }));
        const unread = list.filter((x) => !x.read).length;
        if (q.kind) list = list.filter((x) => x.kind === q.kind);
        if (q.unread === '1') list = list.filter((x) => !x.read);
        return { unread, alerts: list };
      }
      case '/currencies': {
        const d = await file('currencies.json');
        for (const c of d.currencies) c.favorite = favs.has(`currency:${c.code}`);
        d.market = marketStatusClient();
        return d;
      }
      case '/news': { const n = await file('news.json'); return filterNews(n.map((x) => ({ ...x, favorite: favs.has(`news:${x.id}`) })), q, favs); }
      case '/legislation': return filterLegis(await file('legislation.json'), q, favs);
      default: {
        let m = /^\/currencies\/([A-Za-z]{3})\/history$/.exec(p);
        if (m) return file(`history/${m[1].toUpperCase()}-${safeId(q.type || 'comercial')}-${safeId(q.range || '30d')}.json`);
        m = /^\/legislation\/(.+)\/events$/.exec(p);
        if (m) return file(`legis-events/${safeId(decodeURIComponent(m[1]))}.json`);
        throw new Error('Rota não encontrada');
      }
    }
  };
}
