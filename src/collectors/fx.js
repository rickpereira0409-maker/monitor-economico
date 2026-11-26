import { config } from '../config.js';
import { byCode } from '../config/currencies.js';
import { fetchRetry } from '../lib/http.js';
import { spLocalToDate, spDate, addDays, bcbDate } from '../lib/time.js';
import { tx } from '../db.js';

const AW = 'https://economia.awesomeapi.com.br/json';
const PTAX = 'https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata';
const SRC_MARKET = 'AwesomeAPI (cotações de mercado agregadas)';
const SRC_PTAX = 'Banco Central do Brasil (PTAX)';

const withKey = (url) => (config.awesomeApiKey ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(config.awesomeApiKey)}` : url);

function activeCodes(db) {
  return db.prepare('SELECT code FROM currencies WHERE active = 1').all().map((r) => r.code);
}

/** Pares de mercado a coletar: comercial para todas as moedas ativas; turismo onde a fonte oferece. */
function marketPairs(db) {
  const out = [];
  for (const code of activeCodes(db)) {
    const c = byCode[code];
    if (!c) continue;
    out.push({ code, type: 'comercial', pair: `${code}-BRL`, key: `${code}BRL` });
    if (c.tourism) out.push({ code, type: 'turismo', pair: `${code}-BRLT`, key: `${code}BRLT` });
  }
  return out;
}

const pick = (q, type) => (type === 'turismo' ? +q.ask : +q.bid);

function saveQuote(db, { code, type, source, value, ask = null, label = null, ts, now }) {
  db.prepare(`INSERT OR IGNORE INTO fx_quotes (code, rate_type, source, value, ask, label, quote_ts, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(code, type, source, value, ask, label, ts, now.toISOString());
}

function upsertDaily(db, { code, type, source, date, close, final, now }) {
  db.prepare(`INSERT INTO fx_daily (code, rate_type, date, close, source, final, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (code, rate_type, date) DO UPDATE SET close = excluded.close, source = excluded.source, final = excluded.final, updated_at = excluded.updated_at
    WHERE fx_daily.final = 0 OR excluded.final = 1`).run(code, type, date, close, source, final ? 1 : 0, now.toISOString());
}

/** Cotações de mercado (comercial/turismo) – instantâneo atual. */
export async function collectMarket(db, now = new Date(), fetcher = fetchRetry) {
  const pairs = marketPairs(db);
  if (!pairs.length) return { saved: 0, missing: [] };
  const data = await fetcher(withKey(`${AW}/last/${pairs.map((p) => p.pair).join(',')}`), { as: 'json' });
  let saved = 0; const missing = [];
  tx(db, () => {
    for (const p of pairs) {
      const q = data?.[p.key];
      const value = q ? pick(q, p.type) : NaN;
      if (!q || !Number.isFinite(value) || !(+q.timestamp > 0)) { missing.push(p.pair); continue; }
      const ts = new Date(+q.timestamp * 1000).toISOString();
      saveQuote(db, { code: p.code, type: p.type, source: SRC_MARKET, value, ask: +q.ask || null, ts, now });
      upsertDaily(db, { code: p.code, type: p.type, source: SRC_MARKET, date: spDate(new Date(ts)), close: value, final: false, now });
      saved++;
    }
  });
  if (missing.length === pairs.length) throw new Error(`A fonte não retornou nenhum dos pares: ${missing.join(', ')}`);
  return { saved, missing };
}

/** Histórico diário de mercado (últimos `days` dias). Dias anteriores a hoje ficam como fechados. */
export async function backfillMarket(db, days = 120, now = new Date(), fetcher = fetchRetry) {
  const today = spDate(now);
  let rows = 0; const failed = [];
  for (const p of marketPairs(db)) {
    try {
      const arr = await fetcher(withKey(`${AW}/daily/${p.pair}/${days}`), { as: 'json' });
      if (!Array.isArray(arr)) throw new Error('resposta inesperada');
      tx(db, () => {
        for (const q of arr) {
          const v = pick(q, p.type), ts = +q.timestamp;
          if (!Number.isFinite(v) || !(ts > 0)) continue;
          const date = spDate(new Date(ts * 1000));
          upsertDaily(db, { code: p.code, type: p.type, source: SRC_MARKET, date, close: v, final: date < today, now });
          rows++;
        }
      });
    } catch (e) { failed.push(`${p.pair}: ${e.message}`); }
  }
  if (failed.length && !rows) throw new Error(failed.join('; '));
  return { rows, failed };
}

/** PTAX (Banco Central): boletins recentes + fechamentos diários dos últimos `days` dias. */
export async function collectPtax(db, days = 10, now = new Date(), fetcher = fetchRetry) {
  const codes = activeCodes(db).filter((c) => byCode[c]?.ptax);
  const di = bcbDate(addDays(spDate(now), -days)), df = bcbDate(spDate(now));
  let closes = 0, latest = 0; const failed = [];
  for (const code of codes) {
    try {
      const url = `${PTAX}/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@di,dataFinalCotacao=@df)?@moeda='${code}'&@di='${di}'&@df='${df}'&$format=json&$orderby=dataHoraCotacao&$top=10000`;
      const res = await fetcher(url, { as: 'json' });
      const rows = (res.value || []).map((r) => ({ ...r, ts: spLocalToDate(r.dataHoraCotacao) })).filter((r) => r.ts && Number.isFinite(r.cotacaoVenda));
      tx(db, () => {
        for (const r of rows) if (r.tipoBoletim === 'Fechamento') {
          upsertDaily(db, { code, type: 'ptax', source: SRC_PTAX, date: spDate(r.ts), close: r.cotacaoVenda, final: true, now });
          closes++;
        }
        const last = rows[rows.length - 1];
        if (last) {
          saveQuote(db, { code, type: 'ptax', source: SRC_PTAX, value: last.cotacaoVenda, ask: null, label: `Boletim ${last.tipoBoletim}`, ts: last.ts.toISOString(), now });
          latest++;
        }
      });
    } catch (e) { failed.push(`${code}: ${e.message}`); }
  }
  if (failed.length && failed.length === codes.length) throw new Error(failed.join('; '));
  return { closes, latest, failed };
}

export function pruneQuotes(db, now = new Date(), keepDays = 90) {
  const cutoff = new Date(now.getTime() - keepDays * 86400e3).toISOString();
  return db.prepare('DELETE FROM fx_quotes WHERE quote_ts < ?').run(cutoff).changes;
}
