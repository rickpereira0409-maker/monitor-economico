import { TRACKED, DISCOVERY } from '../config/legislation.js';
import { fetchRetry } from '../lib/http.js';
import { deriveStage, extractNorma, inferRegimes, inferTributos, STAGE_INDEX } from '../analysis/legislation.js';
import { tx } from '../db.js';

const API = 'https://dadosabertos.camara.leg.br/api/v2';
const ficha = (id) => `https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=${id}`;

const j = (v) => JSON.stringify(v);
const iso = (s) => { // "2025-07-07T00:00" (horário de Brasília) -> ISO UTC
  if (!s) return null;
  const d = new Date(s.length === 16 ? `${s}:00-03:00` : `${s}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

async function resolveId(db, t, fetcher) {
  const known = db.prepare('SELECT camara_id FROM legis_items WHERE sigla = ? AND numero = ? AND ano = ? AND camara_id IS NOT NULL').get(t.sigla, t.numero, t.ano);
  if (known) return known.camara_id;
  const res = await fetcher(`${API}/proposicoes?siglaTipo=${t.sigla}&numero=${t.numero}&ano=${t.ano}`, { as: 'json' });
  const hit = res.dados?.[0];
  if (!hit) throw new Error(`${t.sigla} ${t.numero}/${t.ano} não encontrada na API da Câmara`);
  return hit.id;
}

/** Atualiza (ou cria) uma proposição. `meta` traz a classificação editorial (curada) ou inferida. */
async function syncItem(db, id, meta, now, fetcher) {
  const det = (await fetcher(`${API}/proposicoes/${id}`, { as: 'json' })).dados;
  const st = det.statusProposicao || {};
  const itemId = `camara:${id}`;
  const prev = db.prepare('SELECT * FROM legis_items WHERE id = ?').get(itemId);

  // Só rebaixa o histórico completo se algo mudou (economiza chamadas).
  const changedMove = !prev || prev.last_seq !== st.sequencia || prev.cod_situacao !== st.codSituacao;
  let events = [];
  if (changedMove) {
    const tr = (await fetcher(`${API}/proposicoes/${id}/tramitacoes`, { as: 'json' })).dados || [];
    events = tr.map((e) => ({ seq: e.sequencia, ts: iso(e.dataHora), orgao: e.siglaOrgao, descricao: e.despacho || e.descricaoTramitacao || '', situacao: e.descricaoSituacao || '' }));
  } else {
    events = db.prepare('SELECT seq, ts, orgao, descricao, situacao FROM legis_events WHERE item_id = ?').all(itemId);
  }

  const { stage, special } = deriveStage(st, events);
  const nowIso = now.toISOString();
  const norma = STAGE_INDEX[stage] >= STAGE_INDEX.sancionada
    ? ([...events].reverse().map((e) => extractNorma(`${e.situacao} ${e.descricao}`)).find(Boolean) || prev?.norma || null)
    : null;
  const m = meta;

  tx(db, () => {
    if (changedMove) {
      const ins = db.prepare('INSERT OR REPLACE INTO legis_events (item_id, seq, ts, orgao, descricao, situacao, stage) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const e of events) ins.run(itemId, e.seq, e.ts, e.orgao, e.descricao, e.situacao, deriveStage({ descricaoSituacao: e.situacao, descricaoTramitacao: e.descricao, siglaOrgao: e.orgao }).stage);
    }
    db.prepare(`INSERT INTO legis_items (id, camara_id, sigla, numero, ano, title, ementa, source_url, official_url, situacao, cod_situacao, stage, special,
        last_move_at, last_move_text, orgao, last_seq, norma, curated, regimes, setores, ufs, tributos, notes, watch, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET ementa=excluded.ementa, source_url=excluded.source_url, official_url=excluded.official_url, situacao=excluded.situacao,
        cod_situacao=excluded.cod_situacao, stage=excluded.stage, special=excluded.special, last_move_at=excluded.last_move_at,
        last_move_text=excluded.last_move_text, orgao=excluded.orgao, last_seq=excluded.last_seq, norma=excluded.norma, fetched_at=excluded.fetched_at,
        title=CASE WHEN excluded.curated=1 THEN excluded.title ELSE legis_items.title END,
        regimes=CASE WHEN excluded.curated=1 THEN excluded.regimes ELSE legis_items.regimes END,
        setores=CASE WHEN excluded.curated=1 THEN excluded.setores ELSE legis_items.setores END,
        ufs=CASE WHEN excluded.curated=1 THEN excluded.ufs ELSE legis_items.ufs END,
        tributos=CASE WHEN excluded.curated=1 THEN excluded.tributos ELSE legis_items.tributos END,
        notes=CASE WHEN excluded.curated=1 THEN excluded.notes ELSE legis_items.notes END,
        watch=CASE WHEN excluded.curated=1 THEN excluded.watch ELSE legis_items.watch END,
        curated=MAX(legis_items.curated, excluded.curated)`)
      .run(itemId, id, det.siglaTipo, det.numero, det.ano, m.title || `${det.siglaTipo} ${det.numero}/${det.ano}`, det.ementa || '',
        det.urlInteiroTeor || null, ficha(id), st.descricaoSituacao || null, st.codSituacao ?? null, stage, special,
        iso(st.dataHora), st.despacho || st.descricaoTramitacao || null, st.siglaOrgao || null, st.sequencia ?? null, norma,
        m.curated ? 1 : 0, j(m.regimes), j(m.setores), j(m.ufs), j(m.tributos), m.notes || null, m.watch || null, nowIso);

    // Só há "mudança" se já conhecíamos a proposição (a primeira leitura é a linha de base e não alerta).
    if (prev) {
      const kinds = [];
      if (prev.stage !== stage) kinds.push('stage');
      if (prev.cod_situacao !== (st.codSituacao ?? null)) kinds.push('situation');
      if (prev.last_seq !== (st.sequencia ?? null)) kinds.push('move');
      if (kinds.length) db.prepare('INSERT INTO events (type, ref, payload, created_at) VALUES (?, ?, ?, ?)')
        .run('legis_change', itemId, j({ kinds, fromStage: prev.stage, toStage: stage, fromSituacao: prev.situacao, toSituacao: st.situacao || null, stageUp: STAGE_INDEX[stage] > STAGE_INDEX[prev.stage] }), nowIso);
    }
  });
  return { itemId, stage, changed: !!prev && (prev.stage !== stage || prev.cod_situacao !== (st.codSituacao ?? null)) };
}

/** Busca por palavras-chave para achar proposições novas sobre tributos. Aplicação ao contribuinte: indeterminada. */
async function discover(db, now, fetcher) {
  const years = [now.getUTCFullYear(), now.getUTCFullYear() - 1];
  const found = new Map();
  for (const kw of DISCOVERY.keywords) {
    for (const ano of years) {
      try {
        const q = new URLSearchParams({ keywords: kw, ano: String(ano), itens: String(DISCOVERY.perKeyword * 3), ordenarPor: 'id', ordem: 'DESC' });
        const res = await fetcher(`${API}/proposicoes?${q}`, { as: 'json', retries: 1 });
        let n = 0;
        for (const p of res.dados || []) {
          if (!DISCOVERY.tipos.includes(p.siglaTipo) || !DISCOVERY.taxRegex.test(p.ementa || '')) continue;
          if (!found.has(p.id) && n < DISCOVERY.perKeyword) { found.set(p.id, p); n++; }
        }
      } catch { /* uma palavra-chave que falha não deve impedir as demais */ }
    }
  }
  return [...found.values()];
}

export async function collectLegislation(db, now = new Date(), { fetcher = fetchRetry, discovery = true, maxDiscovered = 25 } = {}) {
  const out = { tracked: 0, discovered: 0, failed: [] };
  for (const t of TRACKED) {
    try {
      const id = await resolveId(db, t, fetcher);
      await syncItem(db, id, { ...t, curated: true }, now, fetcher);
      out.tracked++;
    } catch (e) { out.failed.push(`${t.sigla} ${t.numero}/${t.ano}: ${e.message}`); }
  }
  if (discovery) {
    try {
      const list = await discover(db, now, fetcher);
      let done = 0;
      for (const p of list) {
        if (done >= maxDiscovered) break;
        const known = db.prepare('SELECT id FROM legis_items WHERE camara_id = ?').get(p.id);
        const text = `${p.ementa} ${p.siglaTipo}`;
        try {
          await syncItem(db, p.id, {
            curated: false, title: `${p.siglaTipo} ${p.numero}/${p.ano}`,
            regimes: inferRegimes(text), setores: ['indeterminado'], ufs: ['indeterminado'], tributos: inferTributos(text),
            notes: 'Encontrada por busca automática de palavras-chave. A aplicação a cada tipo de empresa NÃO foi determinada: leia a ementa e a fonte oficial.',
            watch: null,
          }, now, fetcher);
          if (!known) out.discovered++;
          done++;
        } catch (e) { out.failed.push(`${p.siglaTipo} ${p.numero}/${p.ano}: ${e.message}`); }
      }
    } catch (e) { out.failed.push(`busca automática: ${e.message}`); }
  }
  if (out.tracked === 0 && out.failed.length) throw new Error(`Nenhuma proposição acompanhada pôde ser atualizada. ${out.failed[0]}`);
  return out;
}
