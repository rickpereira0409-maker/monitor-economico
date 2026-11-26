// Coleta única para o GitHub Actions: lê config/settings.json, coleta tudo, avalia alertas, envia notificações (ntfy)
// e gera os arquivos JSON do painel estático. O banco fica em STATE_DIR (branch "data" do repositório).
// Uso: STATE_DIR=state SITE_DIR=site node scripts/collect.js
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { openDb } from '../src/db.js';
import { channelAvailability } from '../src/config.js';
import { applySettings } from '../src/services/settings.js';
import { buildSiteData } from '../src/services/site.js';
import { collectMarket, backfillMarket, collectPtax, pruneQuotes } from '../src/collectors/fx.js';
import { collectNews } from '../src/collectors/news.js';
import { collectLegislation } from '../src/collectors/legislation.js';
import { evaluateFxRules, processEvents, evaluateDeadlines, evaluateDigests } from '../src/alerts/engine.js';
import { flushOutbox } from '../src/alerts/channels.js';

const stateDir = process.env.STATE_DIR || 'state';
const siteDir = process.env.SITE_DIR || 'site';
mkdirSync(stateDir, { recursive: true });
const db = openDb(join(stateDir, 'monitor.db'));
const now = new Date();
const EVERY = 15 * 60000; // intervalo nominal do agendamento do Actions (para o aviso de dados atrasados)

const JOBS = [
  { name: 'fx_market', label: 'Cotações de mercado (AwesomeAPI)', everyMs: EVERY },
  { name: 'fx_ptax', label: 'PTAX (Banco Central)', everyMs: EVERY },
  { name: 'news', label: 'Notícias (feeds RSS/Atom)', everyMs: EVERY },
  { name: 'legislation', label: 'Legislação (API da Câmara)', everyMs: EVERY },
  { name: 'alerts', label: 'Alertas, prazos, resumos e envios', everyMs: EVERY },
];
const results = {};

async function step(name, fn) {
  const started = new Date();
  const id = Number(db.prepare('INSERT INTO job_runs (job, started_at) VALUES (?, ?)').run(name, started.toISOString()).lastInsertRowid);
  let ok = true, info = null, error = null;
  try { info = await fn(); } catch (e) { ok = false; error = String(e.message || e).slice(0, 500); }
  db.prepare('UPDATE job_runs SET finished_at = ?, ok = ?, error = ?, info = ? WHERE id = ?').run(new Date().toISOString(), ok ? 1 : 0, error, info == null ? null : JSON.stringify(info).slice(0, 1500), id);
  results[name] = ok;
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${ok ? '' : `: ${error}`}`);
}

const settings = JSON.parse(readFileSync('config/settings.json', 'utf8'));
console.log('Configurações aplicadas:', applySettings(db, settings, now));

// Carga de histórico: na primeira vez ou a cada 24 h
const last = db.prepare("SELECT value FROM settings WHERE key = 'last_backfill'").get();
if (!last || now - new Date(last.value) > 24 * 3600e3) {
  await step('fx_backfill', async () => {
    const r = { mercado: await backfillMarket(db, 120, now), ptax: await collectPtax(db, 130, now) };
    db.prepare("INSERT INTO settings (key, value) VALUES ('last_backfill', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now.toISOString());
    return r;
  });
}
await step('fx_market', async () => { const r = await collectMarket(db, now); return { ...r, alertas: evaluateFxRules(db, now) }; });
await step('fx_ptax', () => collectPtax(db, 10, now));
await step('news', async () => { const r = await collectNews(db, now); return { feeds: r.feeds.map((f) => `${f.id}:${f.ok ? f.nova : 'erro'}`).join(' ') }; });
await step('legislation', () => collectLegislation(db, now));
await step('alerts', async () => {
  const out = { eventos: processEvents(db, now), prazos: evaluateDeadlines(db, now), resumos: evaluateDigests(db, now) };
  out.envio = await flushOutbox(db, now);
  return out;
});
pruneQuotes(db, now, 90);
db.prepare('DELETE FROM job_runs WHERE started_at < ?').run(new Date(now.getTime() - 14 * 86400e3).toISOString());
db.prepare('DELETE FROM events WHERE processed = 1 AND created_at < ?').run(new Date(now.getTime() - 30 * 86400e3).toISOString());

console.log('Site:', buildSiteData(db, join(siteDir, 'data'), { jobs: JOBS, channels: channelAvailability(), now }));
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
// Falha o workflow só se as fontes principais falharam todas (aparece no GitHub como execução vermelha)
if (!results.fx_market && !results.news && !results.legislation) { console.error('Todas as fontes principais falharam.'); process.exit(1); }
