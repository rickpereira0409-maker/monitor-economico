import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { currenciesView, historyView, newsView, legislationView, legislationDetail, agendaView, alertsView } from './views.js';
import { buildMeta } from './meta.js';
import { jobStatus } from '../scheduler.js';
import { getPrefs } from '../db.js';
import { byCode } from '../config/currencies.js';
import { spDate } from '../lib/time.js';

export const HISTORY_RANGES = ['1d', '7d', '30d', '90d', '365d'];
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '-');

/** Gera os arquivos JSON que o painel estático lê (no lugar da API do servidor). Nunca inclui segredos. */
export function buildSiteData(db, dir, { jobs, channels, now = new Date() }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'history'), { recursive: true });
  mkdirSync(join(dir, 'legis-events'), { recursive: true });
  const put = (name, obj) => writeFileSync(join(dir, name), JSON.stringify(obj));

  const cur = currenciesView(db, now);
  put('currencies.json', cur);
  put('meta.json', buildMeta());
  put('news.json', newsView(db, {}));
  const legis = legislationView(db, {});
  put('legislation.json', legis);
  for (const it of legis) put(`legis-events/${safe(it.id)}.json`, legislationDetail(db, it.id));
  put('agenda.json', agendaView(db, now));
  put('alerts.json', alertsView(db, {}));
  put('rules.json', {
    rules: db.prepare('SELECT * FROM alert_rules ORDER BY id').all().map((r) => ({ id: r.id, type: r.type, name: r.name, params: JSON.parse(r.params), channels: JSON.parse(r.channels), cooldownMin: r.cooldown_min, enabled: !!r.enabled })),
  });
  put('prefs.json', getPrefs(db));

  let files = 0;
  for (const c of cur.currencies.filter((x) => x.active)) {
    for (const t of (c.types || []).filter((x) => x.available)) {
      for (const r of HISTORY_RANGES) { put(`history/${c.code}-${t.type}-${r}.json`, historyView(db, c.code, t.type, r, now)); files++; }
    }
  }
  put('status.json', {
    now: now.toISOString(), generatedAt: now.toISOString(), today: spDate(now), timezone: 'America/Sao_Paulo', static: true,
    channels, jobs: jobStatus(db, jobs, now), authRequired: false,
    demo: db.prepare('SELECT (SELECT COUNT(*) FROM news WHERE is_demo=1) + (SELECT COUNT(*) FROM alerts WHERE is_demo=1) + (SELECT COUNT(*) FROM deadlines WHERE is_demo=1) AS n').get().n > 0,
  });
  return { historyFiles: files, currencies: cur.currencies.filter((x) => byCode[x.code] && x.active).length };
}
