import { CATALOG, byCode, RATE_TYPES } from '../config/currencies.js';
import { marketStatus, freshness, pctChange } from '../lib/fx.js';
import { spDate, addDays, daysBetween } from '../lib/time.js';
import { STAGES, STAGE_INDEX } from '../analysis/legislation.js';

const J = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

// ---------- Moedas ----------

function typeView(db, code, type, now) {
  const q = db.prepare('SELECT value, ask, label, source, quote_ts, fetched_at FROM fx_quotes WHERE code = ? AND rate_type = ? ORDER BY quote_ts DESC LIMIT 1').get(code, type);
  if (!q) return { type, ...RATE_TYPES[type], available: false };
  const qDate = spDate(new Date(q.quote_ts));
  const prev = db.prepare('SELECT close, date FROM fx_daily WHERE code = ? AND rate_type = ? AND date < ? ORDER BY date DESC LIMIT 1').get(code, type, qDate);
  const f = freshness(q.quote_ts, type, now);
  const spark = db.prepare('SELECT date, close FROM fx_daily WHERE code = ? AND rate_type = ? ORDER BY date DESC LIMIT 30').all(code, type).reverse();
  return {
    type, label: RATE_TYPES[type].label, short: RATE_TYPES[type].short, desc: RATE_TYPES[type].desc, available: true,
    value: q.value, ask: q.ask, boletim: q.label, source: q.source, quoteTs: q.quote_ts, fetchedAt: q.fetched_at,
    prevClose: prev?.close ?? null, prevDate: prev?.date ?? null,
    changePct: pctChange(q.value, prev?.close), changeAbs: prev ? q.value - prev.close : null,
    stale: f.stale, staleNote: f.note, ageMin: f.ageMin,
    spark: spark.map((r) => r.close),
  };
}

export function currenciesView(db, now = new Date()) {
  const rows = db.prepare('SELECT code, active, core FROM currencies').all();
  const state = Object.fromEntries(rows.map((r) => [r.code, r]));
  const fav = new Set(db.prepare("SELECT ref FROM favorites WHERE kind = 'currency'").all().map((r) => r.ref));
  return {
    market: marketStatus(now),
    currencies: CATALOG.map((c) => {
      const s = state[c.code] || {};
      const base = { code: c.code, name: c.name, pair: c.pair, decimals: c.decimals, active: !!s.active, core: !!s.core, favorite: fav.has(c.code), hasPtax: c.ptax, hasTourism: !!c.tourism };
      if (!s.active) return base;
      const types = ['ptax', 'comercial', 'turismo']
        .filter((t) => (t === 'ptax' ? c.ptax : t === 'turismo' ? c.tourism : true))
        .map((t) => typeView(db, c.code, t, now));
      return { ...base, types };
    }),
  };
}

const RANGES = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 };

export function historyView(db, code, type, range, now = new Date()) {
  if (!byCode[code]) return null;
  if (!RATE_TYPES[type]) return null;
  let points;
  if (range === '1d') {
    const since = new Date(now.getTime() - 30 * 3600e3).toISOString();
    points = db.prepare('SELECT quote_ts AS t, value AS v FROM fx_quotes WHERE code = ? AND rate_type = ? AND quote_ts >= ? ORDER BY quote_ts').all(code, type, since);
  } else {
    const days = RANGES[range] || 30;
    const from = addDays(spDate(now), -days);
    points = db.prepare('SELECT date AS t, close AS v FROM fx_daily WHERE code = ? AND rate_type = ? AND date >= ? ORDER BY date').all(code, type, from);
  }
  const vals = points.map((p) => p.v);
  const first = points[0], last = points[points.length - 1];
  return {
    code, type, range, label: RATE_TYPES[type].label, granularity: range === '1d' ? 'intradiário (cotações coletadas pelo sistema)' : 'fechamento diário',
    points,
    stats: points.length ? { min: Math.min(...vals), max: Math.max(...vals), changePct: pctChange(last.v, first.v), from: first.t, to: last.t } : null,
  };
}

// ---------- Notícias ----------

export function newsView(db, q = {}) {
  const where = ['duplicate_of IS NULL'], args = [];
  if (q.level) { where.push('level = ?'); args.push(q.level); }
  if (q.direction) { where.push('direction = ?'); args.push(q.direction); }
  if (q.q) { where.push('(title LIKE ? OR summary LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.official === '1') where.push('official = 1');
  if (q.favorites === '1') where.push("id IN (SELECT CAST(ref AS INTEGER) FROM favorites WHERE kind = 'news')");
  const rows = db.prepare(`SELECT * FROM news WHERE ${where.join(' AND ')} ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT 400`).all(...args);
  const fav = new Set(db.prepare("SELECT ref FROM favorites WHERE kind = 'news'").all().map((r) => r.ref));
  let out = rows.map((n) => ({
    id: n.id, title: n.title, summary: n.summary, url: n.url, source: n.source, official: !!n.official,
    publishedAt: n.published_at, firstSeenAt: n.first_seen_at, revision: n.revision, lastChange: n.last_change,
    level: n.level, relevance: n.relevance, direction: n.direction, topics: J(n.topics, []), analysis: J(n.analysis), isDemo: !!n.is_demo, favorite: fav.has(String(n.id)),
  }));
  if (q.topic) out = out.filter((n) => n.topics.includes(q.topic));
  return out.slice(0, 200);
}

// ---------- Legislação ----------

export function legislationView(db, q = {}) {
  const items = db.prepare('SELECT * FROM legis_items ORDER BY curated DESC, last_move_at DESC').all();
  const fav = new Set(db.prepare("SELECT ref FROM favorites WHERE kind = 'legis'").all().map((r) => r.ref));
  const match = (list, wanted, all) => {
    if (!wanted) return 'sim';
    if (!list || !list.length) return 'indeterminado';
    if (list.includes('indeterminado')) return 'indeterminado';
    return list.some((x) => all.includes(x) || x === wanted) ? 'sim' : 'nao';
  };
  const out = [];
  for (const it of items) {
    const regimes = J(it.regimes, ['indeterminado']), setores = J(it.setores, ['indeterminado']), ufs = J(it.ufs, ['indeterminado']);
    const a = [match(regimes, q.regime, ['todos']), match(setores, q.setor, ['todos']), match(ufs, q.uf, ['todas'])];
    const applies = a.includes('nao') ? 'nao' : a.includes('indeterminado') ? 'indeterminado' : 'sim';
    if (applies === 'nao') continue;
    if (applies === 'indeterminado' && q.hideUndetermined === '1') continue;
    if (q.stage && it.stage !== q.stage) continue;
    if (q.favorites === '1' && !fav.has(it.id)) continue;
    if (q.onlyCurated === '1' && !it.curated) continue;
    const st = STAGES[STAGE_INDEX[it.stage]];
    out.push({
      id: it.id, title: it.title, ementa: it.ementa, sigla: it.sigla, numero: it.numero, ano: it.ano, curated: !!it.curated,
      stage: it.stage, stageLabel: st.label, stageHelp: st.help, isLaw: st.isLaw, special: it.special,
      situacao: it.situacao, orgao: it.orgao, lastMoveAt: it.last_move_at, lastMoveText: it.last_move_text, norma: it.norma,
      officialUrl: it.official_url, textUrl: it.source_url, regimes, setores, ufs, tributos: J(it.tributos, []), notes: it.notes, watch: it.watch,
      applies, favorite: fav.has(it.id), fetchedAt: it.fetched_at, isDemo: !!it.is_demo,
    });
  }
  return out;
}

export function legislationDetail(db, id) {
  const events = db.prepare('SELECT seq, ts, orgao, descricao, situacao, stage FROM legis_events WHERE item_id = ? ORDER BY seq DESC LIMIT 60').all(id);
  return { events };
}

// ---------- Agenda ----------

export function agendaView(db, now = new Date()) {
  const today = spDate(now);
  const dl = db.prepare('SELECT * FROM deadlines ORDER BY date').all().map((d) => ({
    id: d.id, title: d.title, date: d.date, kind: d.kind, description: d.description, sourceUrl: d.source_url, origin: d.origin, isDemo: !!d.is_demo,
    daysLeft: daysBetween(today, d.date),
  }));
  const moves = db.prepare(`SELECT e.item_id, e.ts, e.descricao, e.situacao, e.stage, i.title, i.official_url FROM legis_events e JOIN legis_items i ON i.id = e.item_id
    WHERE i.curated = 1 AND e.ts >= ? ORDER BY e.ts DESC LIMIT 30`).all(new Date(now.getTime() - 45 * 86400e3).toISOString());
  return { today, upcoming: dl.filter((d) => d.daysLeft >= 0), past: dl.filter((d) => d.daysLeft < 0).reverse().slice(0, 20), recentMoves: moves };
}

// ---------- Alertas ----------

export function alertsView(db, q = {}) {
  const where = [], args = [];
  if (q.unread === '1') where.push('a.read = 0');
  if (q.kind) { where.push('a.kind = ?'); args.push(q.kind); }
  const rows = db.prepare(`SELECT a.*, (SELECT GROUP_CONCAT(o.channel || ':' || o.status) FROM outbox o WHERE o.alert_id = a.id) AS delivery
    FROM alerts a ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.created_at DESC LIMIT 200`).all(...args);
  return {
    unread: db.prepare('SELECT COUNT(*) n FROM alerts WHERE read = 0').get().n,
    alerts: rows.map((a) => ({ id: a.id, kind: a.kind, title: a.title, body: a.body, link: a.link, severity: a.severity, createdAt: a.created_at, read: !!a.read, isDemo: !!a.is_demo,
      delivery: a.delivery ? a.delivery.split(',').map((x) => { const [channel, status] = x.split(':'); return { channel, status }; }) : [] })),
  };
}
