import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { stageFromText, deriveStage, specialStatus, extractNorma, inferRegimes, STAGE_INDEX } from '../src/analysis/legislation.js';
import { collectLegislation } from '../src/collectors/legislation.js';
import { processEvents, ensureDefaultRules } from '../src/alerts/engine.js';
import { legislationView } from '../src/services/views.js';

const NOW = new Date('2026-11-25T15:00:00Z');

test('stageFromText: etapas legislativas distintas (sem tratar projeto como lei)', () => {
  assert.equal(stageFromText('Apresentação de Proposição', 'MESA'), null);
  assert.equal(stageFromText('Aprovado o Parecer na Comissão de Constituição e Justiça', 'CCJC'), 'comissao');
  assert.equal(stageFromText('Aprovada a Redação Final'), 'aprovada_casa');
  assert.equal(stageFromText('Aprovada a proposição em Plenário', 'PLEN'), 'aprovada_casa');
  assert.equal(stageFromText('Remessa ao Senado Federal por meio do Of. nº 1/2024'), 'aprovada_casa');
  assert.equal(stageFromText('Aguardando Sanção'), 'aprovacao_legislativa');
  assert.equal(stageFromText('Remetida à Sanção'), 'aprovacao_legislativa');
  assert.equal(stageFromText('Transformado na Lei Complementar 214/2025. DOU 16/01/2025'), 'sancionada');
  assert.equal(stageFromText('Transformado em Norma Jurídica com Veto Parcial'), 'sancionada');
  // requerimentos aprovados não significam aprovação da matéria
  assert.equal(stageFromText('Aprovado o Requerimento de Urgência', 'PLEN'), null);
  assert.equal(stageFromText('Aprovado requerimento de audiência pública', 'CFT'), null);
});

test('deriveStage: usa o maior estágio do histórico e sinaliza situações especiais', () => {
  const events = [
    { descricao: 'Apresentação de Proposição', situacao: 'Aguardando Designação', orgao: 'MESA' },
    { descricao: 'Aprovado o Parecer', situacao: 'Pronta para Pauta', orgao: 'CCJC' },
    { descricao: 'Aprovada a Redação Final', situacao: 'Aguardando Remessa ao Senado', orgao: 'PLEN' },
  ];
  assert.equal(deriveStage({ descricaoSituacao: 'Aguardando Apreciação pelo Senado Federal' }, events).stage, 'aprovada_casa');
  assert.equal(deriveStage({ descricaoSituacao: 'Aguardando Despacho' }, [events[0]]).stage, 'proposta');
  const lei = deriveStage({ descricaoSituacao: 'Transformado em Norma Jurídica' }, events);
  assert.equal(lei.stage, 'sancionada');
  assert.ok(STAGE_INDEX[lei.stage] > STAGE_INDEX.aprovacao_legislativa);
  assert.equal(deriveStage({ descricaoSituacao: 'Arquivada' }, [events[0]]).special, 'arquivada');
  assert.equal(specialStatus('Desarquivada'), null);
  assert.equal(specialStatus('Vetado totalmente'), 'veto');
});

test('extractNorma: só a norma criada, não leis citadas na ementa', () => {
  assert.equal(extractNorma('Transformado na Lei Complementar 214/2025. DOU 16/01/2025 PÁG 01'), 'Lei Complementar 214/2025 (DOU 16/01/2025)');
  assert.equal(extractNorma('Transformada na Emenda Constitucional nº 132/2023'), 'Emenda Constitucional 132/2023');
  assert.equal(extractNorma('Altera a Lei Complementar nº 214, de 2025, para dispor sobre o IBS'), null);
});

test('inferRegimes: sem menção explícita, a aplicação é indeterminada', () => {
  assert.deepEqual(inferRegimes('Altera regras do Simples Nacional e do MEI'), ['MEI', 'Simples Nacional']);
  assert.deepEqual(inferRegimes('Dispõe sobre a tributação de lucro presumido'), ['Lucro Presumido']);
  assert.deepEqual(inferRegimes('Institui o IBS e a CBS'), ['indeterminado']);
});

// ---- Coletor com API simulada ----
function fakeCamara(state) {
  return async (url) => {
    if (url.includes('/proposicoes?') && url.includes('siglaTipo=')) {
      const m = /siglaTipo=(\w+)&numero=(\d+)&ano=(\d+)/.exec(url);
      return { dados: [{ id: 1000 + +m[2] }] };
    }
    if (url.includes('keywords=')) return { dados: [] };
    const id = +/proposicoes\/(\d+)/.exec(url)[1];
    const s = state[id] || state.default;
    if (url.endsWith('/tramitacoes')) return { dados: s.events };
    return { dados: { id, siglaTipo: 'PLP', numero: id - 1000, ano: 2024, ementa: 'Ementa de teste', uri: `https://x/${id}`, urlInteiroTeor: 'https://x/teor', statusProposicao: s.status } };
  };
}
const st = (over) => ({ dataHora: '2026-11-20T10:00', sequencia: 1, siglaOrgao: 'MESA', descricaoSituacao: 'Aguardando Designação', codSituacao: 100, despacho: 'Apresentação', descricaoTramitacao: 'Apresentação de Proposição', ...over });

test('collectLegislation: primeira leitura é linha de base; mudança de etapa gera um evento e um alerta', async () => {
  const db = openDb(':memory:'); ensureDefaultRules(db, NOW);
  const state = { default: { status: st(), events: [{ sequencia: 1, dataHora: '2026-11-20T10:00', siglaOrgao: 'MESA', descricaoTramitacao: 'Apresentação de Proposição', descricaoSituacao: 'Aguardando Designação' }] } };
  const f = fakeCamara(state);
  const r1 = await collectLegislation(db, NOW, { fetcher: f, discovery: false });
  assert.equal(r1.tracked, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 0, 'sem alerta na primeira leitura');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM legis_items WHERE stage = 'proposta'").get().n, 4);

  // nada mudou: nenhum evento
  await collectLegislation(db, NOW, { fetcher: f, discovery: false });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);

  // o PLP 68 passa a "Aguardando Sanção"
  state[1068] = { status: st({ sequencia: 2, dataHora: '2026-11-24T12:00', descricaoSituacao: 'Aguardando Sanção', codSituacao: 900, siglaOrgao: 'PLEN' }), events: [
    { sequencia: 1, dataHora: '2026-11-20T10:00', siglaOrgao: 'MESA', descricaoTramitacao: 'Apresentação de Proposição', descricaoSituacao: 'Aguardando Designação' },
    { sequencia: 2, dataHora: '2026-11-24T12:00', siglaOrgao: 'PLEN', descricaoTramitacao: 'Remetida à Sanção', descricaoSituacao: 'Aguardando Sanção' }] };
  await collectLegislation(db, NOW, { fetcher: f, discovery: false });
  const evs = db.prepare('SELECT * FROM events').all();
  assert.equal(evs.length, 1);
  assert.equal(JSON.parse(evs[0].payload).toStage, 'aprovacao_legislativa');
  assert.equal(processEvents(db, NOW), 1);
  const a = db.prepare('SELECT * FROM alerts').get();
  assert.match(a.body, /Aprovação legislativa concluída/);
  assert.match(a.body, /Só passa a ser regra vigente depois de sancionada/);
  // repetir a coleta não cria alerta nem evento novo
  await collectLegislation(db, NOW, { fetcher: f, discovery: false });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
  assert.equal(processEvents(db, NOW), 0);

  // sancionada: guarda a norma e marca como lei
  state[1068] = { status: st({ sequencia: 3, dataHora: '2026-11-25T12:00', descricaoSituacao: 'Transformado em Norma Jurídica', codSituacao: 1140 }), events: [
    { sequencia: 3, dataHora: '2026-11-25T12:00', siglaOrgao: 'MESA', descricaoTramitacao: 'Transformado em Norma Jurídica', despacho: 'Transformado na Lei Complementar 214/2025. DOU 16/01/2025', descricaoSituacao: 'Transformado em Norma Jurídica' }] };
  await collectLegislation(db, NOW, { fetcher: f, discovery: false });
  const item = db.prepare("SELECT stage, norma FROM legis_items WHERE camara_id = 1068").get();
  assert.equal(item.stage, 'sancionada');
  assert.equal(item.norma, 'Lei Complementar 214/2025 (DOU 16/01/2025)');
});

test('collectLegislation: falha em uma proposição não impede as demais; falha total gera erro', async () => {
  const db = openDb(':memory:');
  const flaky = async (url) => { if (url.includes('numero=68')) throw new Error('timeout'); return fakeCamara({ default: { status: st(), events: [] } })(url); };
  const r = await collectLegislation(db, NOW, { fetcher: flaky, discovery: false });
  assert.equal(r.tracked, 3); assert.equal(r.failed.length, 1);
  await assert.rejects(() => collectLegislation(openDb(':memory:'), NOW, { fetcher: async () => { throw new Error('fora do ar'); }, discovery: false }), /Nenhuma proposição/);
});

test('legislationView: filtro por regime/UF deixa explícito quando a aplicação é indeterminada', () => {
  const db = openDb(':memory:');
  const ins = (id, regimes, ufs, curated = 1) => db.prepare(`INSERT INTO legis_items (id, camara_id, sigla, numero, ano, title, stage, regimes, setores, ufs, tributos, curated) VALUES (?, 1, 'PL', 1, 2026, ?, 'proposta', ?, '["todos"]', ?, '[]', ?)`).run(id, id, JSON.stringify(regimes), JSON.stringify(ufs), curated);
  ins('a', ['todos'], ['todas']); ins('b', ['MEI'], ['todas']); ins('c', ['Lucro Real'], ['todas']); ins('d', ['indeterminado'], ['indeterminado'], 0); ins('e', ['Lucro Real'], ['SP']);
  const ids = (q) => legislationView(db, q).map((x) => `${x.id}:${x.applies}`).sort();
  assert.deepEqual(ids({ regime: 'MEI' }), ['a:sim', 'b:sim', 'd:indeterminado']);
  assert.deepEqual(ids({ regime: 'MEI', hideUndetermined: '1' }), ['a:sim', 'b:sim']);
  assert.deepEqual(ids({ regime: 'Lucro Real', uf: 'RJ' }), ['a:sim', 'c:sim', 'd:indeterminado']);
  assert.deepEqual(ids({ regime: 'Lucro Real', uf: 'SP' }), ['a:sim', 'c:sim', 'd:indeterminado', 'e:sim']);
  assert.equal(ids({}).length, 5);
});
