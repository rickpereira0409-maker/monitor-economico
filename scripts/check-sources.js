// Testa de verdade cada integração contra as fontes reais, usando um banco em memória.
// Uso: npm run check:sources
import { openDb } from '../src/db.js';
import { collectMarket, backfillMarket, collectPtax } from '../src/collectors/fx.js';
import { collectNews } from '../src/collectors/news.js';
import { collectLegislation } from '../src/collectors/legislation.js';
import { fmtSP } from '../src/lib/time.js';

const db = openDb(':memory:');
db.exec("UPDATE currencies SET active = 1"); // ativa todas para testar o catálogo inteiro
const now = new Date();
let failures = 0;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`OK    ${name} (${Date.now() - t0} ms)`, JSON.stringify(r).slice(0, 600));
  } catch (e) { failures++; console.log(`FALHA ${name}: ${e.message}`); }
}

await step('Mercado (AwesomeAPI) – cotações atuais', () => collectMarket(db, now));
await step('Mercado (AwesomeAPI) – histórico diário', () => backfillMarket(db, 30, now));
await step('PTAX (Banco Central)', () => collectPtax(db, 15, now));
await step('Notícias (feeds)', async () => {
  const r = await collectNews(db, now);
  return r.feeds.map((f) => `${f.id}:${f.ok ? `${f.items} itens/${f.nova} novas` : 'ERRO ' + f.error}`);
});
await step('Legislação (API da Câmara)', () => collectLegislation(db, now));

console.log('\n--- Amostra de dados gravados ---');
console.table(db.prepare("SELECT code, rate_type, value, quote_ts, label FROM fx_quotes ORDER BY code, rate_type").all().slice(0, 30));
console.table(db.prepare('SELECT id, sigla, numero, ano, stage, situacao, norma, last_move_at FROM legis_items ORDER BY curated DESC LIMIT 10').all());
console.table(db.prepare('SELECT source, level, direction, substr(title,1,70) AS title, published_at FROM news WHERE duplicate_of IS NULL ORDER BY relevance DESC LIMIT 10').all());
console.log('Concluído', fmtSP(new Date()), failures ? `com ${failures} falha(s)` : 'sem falhas');
process.exit(failures ? 1 : 0);
