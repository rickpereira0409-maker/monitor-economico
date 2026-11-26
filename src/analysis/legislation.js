import { stripAccents } from './news.js';

// Etapas do processo, em ordem. Só 'sancionada' em diante representa norma jurídica existente;
// 'regulamentacao' e 'vigencia' não são inferidas da API da Câmara (ver README): dependem de fonte curada.
export const STAGES = [
  { id: 'proposta', label: 'Proposta em discussão', isLaw: false, help: 'Projeto ou proposta em tramitação. Ainda NÃO é regra vigente.' },
  { id: 'comissao', label: 'Aprovada em comissão', isLaw: false, help: 'Aprovada em comissão. Ainda NÃO é regra vigente.' },
  { id: 'aprovada_casa', label: 'Aprovada em uma das Casas', isLaw: false, help: 'Aprovada pela Câmara ou pelo Senado; falta a outra Casa. Ainda NÃO é regra vigente.' },
  { id: 'aprovacao_legislativa', label: 'Aprovação legislativa concluída', isLaw: false, help: 'Aprovada pelo Congresso; aguarda sanção (ou promulgação). Ainda NÃO é regra vigente.' },
  { id: 'sancionada', label: 'Sancionada/promulgada e publicada', isLaw: true, help: 'Virou norma jurídica (lei sancionada ou emenda constitucional promulgada). A entrada em vigor e o início dos efeitos podem ter datas próprias; veja os prazos na norma.' },
  { id: 'regulamentacao', label: 'Em regulamentação', isLaw: true, help: 'Norma publicada com regulamentação em andamento (informação curada).' },
  { id: 'vigencia', label: 'Em vigor / efeitos iniciados', isLaw: true, help: 'Norma em vigor, com efeitos já iniciados (informação curada).' },
];
export const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));
export const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label || id;

const norm = (s) => stripAccents(s).toLowerCase();
const PLENARY = /^(plen|pl|plenario|sf|plen-sf)$/i;

/**
 * Estágio sugerido por um texto de tramitação/situação. Heurística sobre descrições da Câmara:
 * por isso o sistema sempre mostra o texto original e o link para a fonte oficial.
 */
export function stageFromText(text, orgao = '') {
  const t = norm(text);
  if (!t) return null;
  if (/transformad[oa] (em|na) (norma juridica|lei|emenda)|sancionad[oa]|promulgad[oa]|publicad[oa] (a |o )?(lei|emenda)/.test(t)) return 'sancionada';
  if (/aguardando (sancao|promulgacao)|remetid[oa] a (sancao|promulgacao)|enviad[oa] a (sancao|promulgacao)|encaminhad[oa] a (sancao|promulgacao)/.test(t)) return 'aprovacao_legislativa';
  if (/requerimento/.test(t)) return null; // requerimentos aprovados (urgência etc.) não são aprovação da matéria
  if (/remetid[oa] ao senado|remessa ao senado|remetid[oa] a camara|aprovad[oa] pelo senado|aprovad[oa] (em|no) (primeiro|segundo|1o|2o|1|2) turno|aprovad[oa] a redacao final/.test(t)) return 'aprovada_casa';
  if (/aprovad[oa]/.test(t) && PLENARY.test(orgao.trim()) ) return 'aprovada_casa';
  if (/aprovad[oa]/.test(t) && /(parecer|substitutivo|projeto|proposta|proposicao)/.test(t) && !PLENARY.test(orgao.trim()) && !/^mesa$/i.test(orgao.trim())) return 'comissao';
  return null;
}

export function specialStatus(text) {
  const t = norm(text);
  if (/arquivad[oa]/.test(t) && !/desarquiv/.test(t)) return 'arquivada';
  if (/retirad[oa] (pelo|de) autor|retirada de pauta definitivamente/.test(t)) return 'retirada';
  if (/rejeitad[oa]/.test(t)) return 'rejeitada';
  if (/veto (total|parcial)|vetad[oa]/.test(t)) return 'veto';
  return null;
}

/**
 * Deriva o estágio de uma proposição a partir do status atual e do histórico.
 * events: [{descricao, situacao, orgao}]; status: {descricaoSituacao, descricaoTramitacao, despacho, siglaOrgao}
 */
export function deriveStage(status = {}, events = []) {
  let best = 0, bestId = 'proposta';
  const consider = (id) => { if (id && STAGE_INDEX[id] > best) { best = STAGE_INDEX[id]; bestId = id; } };
  for (const e of events) consider(stageFromText(`${e.situacao || ''} ${e.descricao || ''}`, e.orgao || ''));
  consider(stageFromText(`${status.descricaoSituacao || ''} ${status.descricaoTramitacao || ''} ${status.despacho || ''}`, status.siglaOrgao || ''));
  const special = specialStatus(`${status.descricaoSituacao || ''} ${status.descricaoTramitacao || ''}`);
  return { stage: bestId, special };
}

/**
 * Extrai a norma CRIADA a partir de uma tramitação como "Transformado na Lei Complementar 214/2025. DOU 16/01/2025 ...".
 * Só reconhece o padrão de transformação em norma, para não confundir com leis apenas citadas ou alteradas na ementa.
 */
export function extractNorma(text) {
  const m = /Transformad[oa] (?:em|na|no)\s+(Lei Complementar|Emenda Constitucional|Lei Ordin[aá]ria|Lei)\s*(?:n[ºo°.]*\s*)?([\d.]+)\s*\/\s*(\d{4})/i.exec(text || '');
  if (!m) return null;
  const dou = /DOU\s+(\d{2}\/\d{2}\/\d{4})/i.exec(text);
  return `${m[1]} ${m[2]}/${m[3]}${dou ? ` (DOU ${dou[1]})` : ''}`;
}

const REGIME_PATTERNS = [
  ['MEI', /\bmei\b|microempreendedor individual/],
  ['Simples Nacional', /simples nacional|microempresa|empresa de pequeno porte|\bme\b.*\bepp\b/],
  ['Lucro Presumido', /lucro presumido/],
  ['Lucro Real', /lucro real/],
];

/** Inferência simples, e declarada como tal, de regimes mencionados na ementa. Sem menção => indeterminado. */
export function inferRegimes(text) {
  const t = norm(text);
  const found = REGIME_PATTERNS.filter(([, re]) => re.test(t)).map(([n]) => n);
  return found.length ? found : ['indeterminado'];
}

export function inferTributos(text) {
  const t = text || '';
  const list = ['IBS', 'CBS', 'IRPJ', 'IRPF', 'CSLL', 'ICMS', 'ISS', 'IPI', 'IOF', 'PIS', 'Cofins', 'Imposto Seletivo', 'Simples Nacional', 'ITCMD']
    .filter((x) => new RegExp(`\\b${x}\\b`, 'i').test(t));
  return list;
}
