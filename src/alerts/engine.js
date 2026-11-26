import { getPrefs } from '../db.js';
import { windowChange, pctChange } from '../lib/fx.js';
import { spParts, spDate, daysBetween, fmtSP } from '../lib/time.js';
import { fmtBRL, fmtPct, typeLabel } from '../lib/format.js';
import { byCode } from '../config/currencies.js';
import { stageLabel } from '../analysis/legislation.js';

export const RULE_TYPES = {
  price_above: 'Cotação acima de um valor',
  price_below: 'Cotação abaixo de um valor',
  pct_move: 'Variação percentual em uma janela de tempo',
  news: 'Notícias de maior relevância',
  legis: 'Mudança de situação em propostas e normas',
  deadline: 'Lembrete de prazos',
};
const LEVEL_RANK = { baixa: 0, media: 1, alta: 2 };
const MAX_QUOTE_AGE_MS = 6 * 3600e3; // não dispara alerta de preço com cotação velha

// ---------- Funções puras (testadas em test/) ----------

/**
 * Gatilho de preço com "rearme": dispara uma vez ao cruzar o limite e só dispara de novo
 * depois que a cotação voltar para o outro lado. Evita repetir o mesmo alerta a cada coleta.
 */
export function evalPriceRule(type, threshold, value, armed) {
  const cond = type === 'price_above' ? value >= threshold : value <= threshold;
  if (!cond) return { fire: false, armed: true };
  return { fire: armed, armed: false };
}

/** Janela de recebimento para canais externos (aceita janela que atravessa a meia-noite). */
export function inDeliveryWindow(d, now) {
  const p = spParts(now);
  if (d.weekdaysOnly && (p.weekday === 0 || p.weekday === 6)) return false;
  const s = Number(d.startHour), e = Number(d.endHour);
  if (s === e) return true;
  return s < e ? p.hour >= s && p.hour < e : p.hour >= s || p.hour < e;
}

export const cooldownOk = (lastFiredIso, cooldownMin, now) => !lastFiredIso || now - new Date(lastFiredIso) >= cooldownMin * 60000;

export function newsMatchesRule(news, params) {
  const min = LEVEL_RANK[params.minLevel || 'alta'];
  if ((LEVEL_RANK[news.level] ?? 0) < min) return false;
  const topics = JSON.parse(news.topics || '[]');
  if (params.topics?.length && !topics.some((t) => params.topics.includes(t))) return false;
  if (params.directions?.length && !params.directions.includes(news.direction)) return false;
  return true;
}

export function weekKey(now) { // segunda-feira da semana, em SP
  const p = spParts(now);
  const back = (p.weekday + 6) % 7;
  return new Date(Date.parse(`${p.date}T12:00:00Z`) - back * 86400e3).toISOString().slice(0, 10);
}

// ---------- Criação de alertas ----------

const parseChannels = (s) => { try { return JSON.parse(s); } catch { return ['inapp']; } };

/**
 * Cria o alerta se a chave de deduplicação ainda não existir. Retorna o id, ou null se já existia.
 * Para canais externos, enfileira o envio (a fila respeita janela de horário e intervalo mínimo).
 */
export function createAlert(db, { kind, dedupeKey, ruleId = null, title, body = '', link = null, severity = 'info', channels = ['inapp'], now = new Date(), isDemo = 0 }) {
  const info = db.prepare(`INSERT OR IGNORE INTO alerts (kind, dedupe_key, rule_id, title, body, link, severity, created_at, is_demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(kind, dedupeKey, ruleId, title, body, link, severity, now.toISOString(), isDemo);
  if (!info.changes) return null;
  const id = Number(info.lastInsertRowid);
  const prefs = getPrefs(db);
  for (const ch of new Set(channels)) {
    if (ch === 'inapp' || !prefs.channels[ch]?.enabled) continue;
    db.prepare('INSERT OR IGNORE INTO outbox (alert_id, channel, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)').run(id, ch, 'pending', now.toISOString(), now.toISOString());
  }
  return id;
}

export const DEFAULT_RULES = [
  { type: 'news', name: 'Notícias de alta relevância', params: { minLevel: 'alta', topics: [], directions: [] }, channels: ['inapp'], cooldown_min: 0 },
  { type: 'legis', name: 'Mudanças em propostas e normas acompanhadas', params: { mode: 'stage', onlyCurated: true }, channels: ['inapp'], cooldown_min: 0 },
  { type: 'deadline', name: 'Lembretes de prazos (7, 3, 1 dia e no dia)', params: { daysBefore: [7, 3, 1, 0] }, channels: ['inapp'], cooldown_min: 0 },
];

export function ensureDefaultRules(db, now = new Date()) {
  if (db.prepare('SELECT COUNT(*) n FROM alert_rules').get().n) return;
  for (const r of DEFAULT_RULES) addRule(db, r, now);
}

export function addRule(db, r, now = new Date()) {
  const info = db.prepare('INSERT INTO alert_rules (type, name, params, channels, cooldown_min, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(r.type, r.name, JSON.stringify(r.params || {}), JSON.stringify(r.channels || ['inapp']), r.cooldown_min ?? 60, now.toISOString());
  return Number(info.lastInsertRowid);
}

const rulesOf = (db, ...types) => db.prepare(`SELECT * FROM alert_rules WHERE enabled = 1 AND type IN (${types.map(() => '?').join(',')})`).all(...types)
  .map((r) => ({ ...r, params: JSON.parse(r.params), channels: parseChannels(r.channels) }));

function ruleState(db, id) {
  return db.prepare('SELECT * FROM rule_state WHERE rule_id = ?').get(id) || { rule_id: id, armed: 1, last_fired_at: null, last_key: null };
}
function saveState(db, id, armed, lastFiredAt, lastKey) {
  db.prepare(`INSERT INTO rule_state (rule_id, armed, last_fired_at, last_key) VALUES (?, ?, ?, ?)
    ON CONFLICT (rule_id) DO UPDATE SET armed = excluded.armed, last_fired_at = COALESCE(excluded.last_fired_at, rule_state.last_fired_at), last_key = COALESCE(excluded.last_key, rule_state.last_key)`)
    .run(id, armed ? 1 : 0, lastFiredAt, lastKey);
}

// ---------- Avaliação: câmbio ----------

export function evaluateFxRules(db, now = new Date()) {
  let created = 0;
  for (const rule of rulesOf(db, 'price_above', 'price_below', 'pct_move')) {
    const { code, rate_type: rt = 'comercial' } = rule.params;
    const c = byCode[code];
    if (!c) continue;
    const latest = db.prepare('SELECT value, quote_ts, source FROM fx_quotes WHERE code = ? AND rate_type = ? ORDER BY quote_ts DESC LIMIT 1').get(code, rt);
    if (!latest || now - new Date(latest.quote_ts) > MAX_QUOTE_AGE_MS) continue;
    const st = ruleState(db, rule.id);

    if (rule.type === 'pct_move') {
      const windowMs = (rule.params.windowMin || 60) * 60000;
      const rows = db.prepare('SELECT value, quote_ts FROM fx_quotes WHERE code = ? AND rate_type = ? AND quote_ts >= ?').all(code, rt, new Date(now - windowMs).toISOString());
      const wc = windowChange(rows.map((r) => ({ t: Date.parse(r.quote_ts), v: r.value })), windowMs, now.getTime());
      if (!wc || Math.abs(wc.pct) < rule.params.pct) continue;
      const cd = Math.max(rule.cooldown_min, rule.params.windowMin || 60);
      if (!cooldownOk(st.last_fired_at, cd, now)) continue;
      const dir = wc.pct > 0 ? 'alta' : 'queda';
      const id = createAlert(db, {
        kind: 'cambio', ruleId: rule.id, dedupeKey: `pct:${rule.id}:${dir}:${Math.floor(now.getTime() / windowMs)}`, severity: 'atencao', channels: rule.channels, now,
        title: `${c.pair}: ${dir} de ${fmtPct(wc.pct)} em ${rule.params.windowMin || 60} min`,
        body: `${typeLabel(rt)}: de ${fmtBRL(wc.from.v, code)} para ${fmtBRL(wc.to.v, code)} (${fmtSP(new Date(wc.from.t))} → ${fmtSP(new Date(wc.to.t))}, horário de Brasília). Fonte: ${latest.source}. A oscilação pode ter várias causas; este alerta não indica o motivo.`,
        link: '#/moedas',
      });
      if (id) { created++; saveState(db, rule.id, true, now.toISOString(), `pct:${dir}`); }
      continue;
    }

    const { fire, armed } = evalPriceRule(rule.type, rule.params.value, latest.value, !!st.armed);
    if (armed !== !!st.armed) saveState(db, rule.id, armed, null, null);
    if (!fire || !cooldownOk(st.last_fired_at, rule.cooldown_min, now)) continue;
    const above = rule.type === 'price_above';
    const id = createAlert(db, {
      kind: 'cambio', ruleId: rule.id, dedupeKey: `price:${rule.id}:${latest.quote_ts}`, severity: 'atencao', channels: rule.channels, now,
      title: `${c.pair} ${above ? 'acima' : 'abaixo'} de ${fmtBRL(rule.params.value, code)}`,
      body: `${typeLabel(rt)}: ${fmtBRL(latest.value, code)} em ${fmtSP(new Date(latest.quote_ts))} (horário de Brasília). Fonte: ${latest.source}.`,
      link: '#/moedas',
    });
    if (id) { created++; saveState(db, rule.id, false, now.toISOString(), `price:${latest.quote_ts}`); }
  }
  return created;
}

// ---------- Avaliação: eventos de notícias e legislação ----------

export function processEvents(db, now = new Date()) {
  const events = db.prepare('SELECT * FROM events WHERE processed = 0 ORDER BY id LIMIT 500').all();
  const newsRules = rulesOf(db, 'news'), legisRules = rulesOf(db, 'legis');
  let created = 0;
  for (const ev of events) {
    try {
      if (ev.type === 'news_new' || ev.type === 'news_update') created += handleNews(db, ev, newsRules, now) ? 1 : 0;
      else if (ev.type === 'legis_change') created += handleLegis(db, ev, legisRules, now) ? 1 : 0;
    } catch (e) { console.error('[alertas] erro ao processar evento', ev.id, e.message); }
    db.prepare('UPDATE events SET processed = 1 WHERE id = ?').run(ev.id);
  }
  return created;
}

function handleNews(db, ev, rules, now) {
  const n = db.prepare('SELECT * FROM news WHERE id = ?').get(Number(ev.ref));
  if (!n || n.duplicate_of) return false;
  const matching = rules.filter((r) => newsMatchesRule(n, r.params) && !(r.params.onlyUpdates && ev.type === 'news_new'));
  if (!matching.length) return false;
  const isUpd = ev.type === 'news_update';
  const dir = { alta: 'pressão de ALTA sobre o dólar', baixa: 'pressão de BAIXA sobre o dólar', incerto: 'efeito incerto sobre o dólar' }[n.direction];
  return !!createAlert(db, {
    kind: 'noticia', dedupeKey: `news:${n.id}:r${n.revision}`, severity: n.level === 'alta' ? 'atencao' : 'info', now,
    channels: [...new Set(matching.flatMap((r) => r.channels))],
    title: `${isUpd ? 'Atualização: ' : ''}${n.title}`,
    body: `${n.source} • ${n.published_at ? fmtSP(new Date(n.published_at)) : 'data não informada'}. Interpretação automática (não é previsão): ${dir}. Leia a publicação original para confirmar os fatos.`,
    link: n.url,
  });
}

function handleLegis(db, ev, rules, now) {
  const item = db.prepare('SELECT * FROM legis_items WHERE id = ?').get(ev.ref);
  const p = JSON.parse(ev.payload || '{}');
  if (!item) return false;
  const matching = rules.filter((r) => {
    if (r.params.onlyCurated && !item.curated) return false;
    if (r.params.itemIds?.length && !r.params.itemIds.includes(item.id)) return false;
    const major = p.kinds.includes('stage') || p.kinds.includes('situation');
    return r.params.mode === 'any' ? true : major;
  });
  if (!matching.length) return false;
  const major = p.kinds.includes('stage') || p.kinds.includes('situation');
  const key = major ? `legis:${item.id}:${item.stage}:${item.cod_situacao}` : `legis:${item.id}:move:${item.last_seq}`;
  const stageTxt = p.kinds.includes('stage') ? `Etapa: ${stageLabel(p.fromStage)} → ${stageLabel(p.toStage)}.` : `Etapa: ${stageLabel(item.stage)}.`;
  return !!createAlert(db, {
    kind: 'legislacao', dedupeKey: key, severity: major ? 'atencao' : 'info', now, channels: [...new Set(matching.flatMap((r) => r.channels))],
    title: `${item.title}: ${major ? 'mudança de situação' : 'nova movimentação'}`,
    body: `${stageTxt} Situação: ${item.situacao || 'não informada'}. Última movimentação: ${item.last_move_at ? fmtSP(new Date(item.last_move_at)) : '—'}. Só passa a ser regra vigente depois de sancionada/publicada e dentro dos prazos de vigência da própria norma.`,
    link: item.official_url,
  });
}

// ---------- Avaliação: prazos ----------

export function evaluateDeadlines(db, now = new Date()) {
  const rules = rulesOf(db, 'deadline');
  if (!rules.length) return 0;
  const today = spDate(now);
  let created = 0;
  for (const d of db.prepare('SELECT * FROM deadlines WHERE date >= ?').all(today)) {
    const left = daysBetween(today, d.date);
    const matching = rules.filter((r) => (r.params.daysBefore || [7, 3, 1, 0]).includes(left));
    if (!matching.length) continue;
    const when = left === 0 ? 'é HOJE' : left === 1 ? 'é amanhã' : `é em ${left} dias`;
    const id = createAlert(db, {
      kind: 'prazo', dedupeKey: `deadline:${d.id}:${left}`, severity: left <= 1 ? 'atencao' : 'info', now, isDemo: d.is_demo, channels: [...new Set(matching.flatMap((r) => r.channels))],
      title: `Prazo ${when}: ${d.title}`, body: `${d.description || ''} Data: ${d.date.split('-').reverse().join('/')}.`.trim(), link: d.source_url || '#/agenda',
    });
    if (id) created++;
  }
  return created;
}

// ---------- Resumos diário e semanal ----------

export function buildDigest(db, now, period) {
  const days = period === 'weekly' ? 7 : 1;
  const since = new Date(now - days * 86400e3).toISOString();
  const lines = [];
  lines.push('MOEDAS (variação sobre o fechamento anterior do mesmo tipo de cotação)');
  for (const c of db.prepare('SELECT code FROM currencies WHERE active = 1').all()) {
    const cfg = byCode[c.code];
    const rt = 'comercial';
    const q = db.prepare('SELECT value, quote_ts FROM fx_quotes WHERE code = ? AND rate_type = ? ORDER BY quote_ts DESC LIMIT 1').get(c.code, rt);
    if (!q) continue;
    const base = db.prepare('SELECT close FROM fx_daily WHERE code = ? AND rate_type = ? AND date < ? ORDER BY date DESC LIMIT ?').all(c.code, rt, spDate(new Date(q.quote_ts)), days).pop();
    lines.push(`• ${cfg.pair}: ${fmtBRL(q.value, c.code)} (${fmtPct(pctChange(q.value, base?.close))}) — comercial, ${fmtSP(new Date(q.quote_ts))}`);
  }
  const news = db.prepare(`SELECT title, source, url, direction FROM news WHERE duplicate_of IS NULL AND is_demo = 0 AND first_seen_at >= ? AND level IN ('alta','media') ORDER BY relevance DESC, published_at DESC LIMIT 6`).all(since);
  lines.push('', 'NOTÍCIAS DE MAIOR RELEVÂNCIA (interpretação automática; confirme na fonte)');
  if (!news.length) lines.push('• Nenhuma no período.');
  for (const n of news) lines.push(`• ${n.title} — ${n.source}\n  ${n.url}`);
  const legis = db.prepare(`SELECT title, body FROM alerts WHERE kind = 'legislacao' AND created_at >= ? ORDER BY created_at DESC LIMIT 8`).all(since);
  lines.push('', 'REFORMA TRIBUTÁRIA E LEGISLAÇÃO');
  if (!legis.length) lines.push('• Sem mudança de situação nas proposições acompanhadas.');
  for (const l of legis) lines.push(`• ${l.title}`);
  const today = spDate(now);
  const horizon = new Date(now.getTime() + (days === 7 ? 14 : 7) * 86400e3);
  const dl = db.prepare('SELECT title, date FROM deadlines WHERE date >= ? AND date <= ? ORDER BY date').all(today, spDate(horizon));
  lines.push('', `PRÓXIMOS PRAZOS (${days === 7 ? '14' : '7'} dias)`);
  if (!dl.length) lines.push('• Nenhum prazo cadastrado no período.');
  for (const d of dl) lines.push(`• ${d.date.split('-').reverse().join('/')} — ${d.title}`);
  return lines.join('\n');
}

export function evaluateDigests(db, now = new Date()) {
  const prefs = getPrefs(db), p = spParts(now);
  let created = 0;
  const make = (period, key, title) => {
    if (db.prepare('SELECT 1 FROM alerts WHERE dedupe_key = ?').get(key)) return; // já gerado: não remonta o resumo
    const cfg = prefs.digest[period];
    const id = createAlert(db, { kind: 'resumo', dedupeKey: key, severity: 'info', now, channels: cfg.channels || ['inapp'], title, body: buildDigest(db, now, period), link: '#/alertas' });
    if (id) created++;
  };
  const d = prefs.digest.daily;
  if (d.enabled && p.hour >= d.hour) make('daily', `digest:daily:${p.date}`, `Resumo diário — ${p.date.split('-').reverse().join('/')}`);
  const w = prefs.digest.weekly;
  if (w.enabled && p.weekday === Number(w.weekday) && p.hour >= w.hour) make('weekly', `digest:weekly:${weekKey(now)}`, `Resumo semanal — semana de ${weekKey(now).split('-').reverse().join('/')}`);
  return created;
}
