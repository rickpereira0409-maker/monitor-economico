import { config } from './config.js';
import { collectMarket, backfillMarket, collectPtax, pruneQuotes } from './collectors/fx.js';
import { collectNews } from './collectors/news.js';
import { collectLegislation } from './collectors/legislation.js';
import { ensureDefaultRules, evaluateFxRules, processEvents, evaluateDeadlines, evaluateDigests } from './alerts/engine.js';
import { flushOutbox } from './alerts/channels.js';

const MIN = 60000;

/** Define as tarefas agendadas. Intervalos configuráveis por variável de ambiente (ver .env.example). */
export function buildJobs(db) {
  const i = config.intervals;
  return [
    { name: 'fx_backfill', label: 'Histórico de câmbio (carga diária)', everyMs: 24 * 60 * MIN, startDelayMs: 0,
      run: async (now) => ({ mercado: await backfillMarket(db, 120, now), ptax: await collectPtax(db, 130, now) }) },
    { name: 'fx_market', label: 'Cotações de mercado (AwesomeAPI)', everyMs: i.fxMarket * MIN, startDelayMs: 3000,
      run: async (now) => { const r = await collectMarket(db, now); return { ...r, alertas: evaluateFxRules(db, now) }; } },
    { name: 'fx_ptax', label: 'PTAX (Banco Central)', everyMs: i.fxPtax * MIN, startDelayMs: 8000,
      run: async (now) => collectPtax(db, 10, now) },
    { name: 'news', label: 'Notícias (feeds RSS/Atom)', everyMs: i.news * MIN, startDelayMs: 12000,
      run: async (now) => { const r = await collectNews(db, now); return { feeds: r.feeds.map((f) => `${f.id}:${f.ok ? f.nova : 'erro'}`).join(' '), alertas: processEvents(db, now) }; } },
    { name: 'legislation', label: 'Legislação (API da Câmara)', everyMs: i.legislation * MIN, startDelayMs: 25000,
      run: async (now) => { const r = await collectLegislation(db, now); return { ...r, alertas: processEvents(db, now) }; } },
    { name: 'alerts', label: 'Alertas, prazos, resumos e envios', everyMs: i.alerts * MIN, startDelayMs: 40000,
      run: async (now) => {
        ensureDefaultRules(db, now);
        const out = { eventos: processEvents(db, now), prazos: evaluateDeadlines(db, now), resumos: evaluateDigests(db, now) };
        out.envio = await flushOutbox(db, now);
        return out;
      } },
    { name: 'maintenance', label: 'Limpeza de dados antigos', everyMs: 24 * 60 * MIN, startDelayMs: 60000,
      run: async (now) => {
        const cut = new Date(now.getTime() - 30 * 86400e3).toISOString();
        return {
          cotacoes: pruneQuotes(db, now, 90),
          execucoes: db.prepare('DELETE FROM job_runs WHERE started_at < ?').run(cut).changes,
          eventos: db.prepare('DELETE FROM events WHERE processed = 1 AND created_at < ?').run(cut).changes,
        };
      } },
  ];
}
