// Insere itens de DEMONSTRAÇÃO (is_demo=1), exibidos no painel com a etiqueta "DEMONSTRAÇÃO".
// Uso: npm run seed:demo   |   remover: npm run seed:demo -- --remove
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import { analyzeNews } from '../src/analysis/news.js';
import { addDays, spDate } from '../src/lib/time.js';

const db = openDb(config.dbPath);
if (process.argv.includes('--remove')) {
  for (const t of ['news', 'alerts', 'deadlines']) db.prepare(`DELETE FROM ${t} WHERE is_demo = 1`).run();
  console.log('Itens de demonstração removidos.'); process.exit(0);
}
const now = new Date();
const a = analyzeNews({ title: '[DEMO] Copom eleva a Selic em 0,25 ponto percentual', summary: 'Texto fictício para demonstração da interface.', source: 'Fonte fictícia', url: 'https://example.com/demo', publishedAt: now.toISOString(), official: false }, now);
db.prepare(`INSERT OR IGNORE INTO news (key, norm_title, url, source, title, summary, published_at, first_seen_at, last_seen_at, content_hash, relevance, level, direction, topics, analysis, is_demo)
  VALUES ('demo-1', 'demo1', 'https://example.com/demo', 'Fonte fictícia', '[DEMO] Copom eleva a Selic em 0,25 ponto percentual', 'Texto fictício para demonstração da interface.', ?, ?, ?, 'demo', ?, ?, ?, ?, ?, 1)`)
  .run(now.toISOString(), now.toISOString(), now.toISOString(), a.relevance, a.level, a.direction, JSON.stringify(a.topics), JSON.stringify(a.analysis));
db.prepare("INSERT OR IGNORE INTO alerts (kind, dedupe_key, title, body, severity, created_at, is_demo) VALUES ('cambio', 'demo-alert', '[DEMO] USD/BRL acima de R$ 6,00', 'Alerta fictício para demonstração.', 'atencao', ?, 1)").run(now.toISOString());
db.prepare("INSERT OR IGNORE INTO deadlines (title, date, kind, description, origin, ref, is_demo) VALUES ('[DEMO] Prazo fictício de obrigação acessória', ?, 'prazo', 'Item de demonstração.', 'demo', 'demo-1', 1)").run(addDays(spDate(now), 5));
console.log('Itens de demonstração inseridos (etiquetados como DEMONSTRAÇÃO).');
