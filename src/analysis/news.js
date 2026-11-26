import { createHash } from 'node:crypto';

// ---------- Normalização e deduplicação ----------
export const stripAccents = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Título normalizado para comparar publicações: sem acento, sem " - Veículo" final, sem pontuação. */
export function normTitle(title, publisher) {
  let t = String(title ?? '');
  if (publisher) t = t.replace(new RegExp(`\\s[-–|]\\s${publisher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '');
  else t = t.replace(/\s[-–|]\s[^-–|]{2,40}$/, (m) => (m.length < 40 ? '' : m)); // sufixo curto de veículo
  return stripAccents(t).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|cmpid|src$)/i.test(k)) u.searchParams.delete(k);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/$/, '');
  } catch { return String(url ?? ''); }
}

export const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export function newsKey(feedId, item) {
  return sha1(`${feedId}|${item.id || canonicalUrl(item.link)}`);
}

const tokens = (s) => new Set(stripAccents(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Similaridade de Jaccard entre dois textos (0 a 1). */
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export const contentHash = (title, summary) => sha1(`${normTitle(title)}|${stripAccents(summary || '').toLowerCase().replace(/\s+/g, ' ').trim()}`);

/**
 * Classifica o que aconteceu com uma notícia já conhecida:
 *  - republicacao: mesmo conteúdo (só mudou data/metadado) -> não gera alerta
 *  - ajuste_menor: texto quase igual (correção de vírgula, etc.) -> não gera alerta
 *  - atualizacao: título ou resumo mudaram de forma relevante -> pode gerar alerta
 */
export function classifyChange(prev, next) {
  if (prev.content_hash === contentHash(next.title, next.summary)) return 'republicacao';
  const titleSim = similarity(prev.title, next.title);
  const sumSim = prev.summary || next.summary ? similarity(prev.summary || '', next.summary || '') : 1;
  if (titleSim >= 0.85 && sumSim >= 0.8) return 'ajuste_menor';
  return 'atualizacao';
}

// ---------- Temas e interpretação por regras ----------
// Interpretação determinística (sem IA): cada tema tem padrões, uma explicação econômica geral e o efeito típico
// sobre empresas. O texto NÃO afirma que a notícia causou qualquer oscilação: descreve um mecanismo conhecido.
const t = (id, label, weight, re, why, empresas) => ({ id, label, weight, re, why, empresas });

export const TOPICS = [
  t('juros_br', 'Juros no Brasil', 60, /\b(copom|selic|taxa basica de juros|juros? (no|do) brasil|banco central.{0,40}juros|decisao de juros)\b/,
    'Juros mais altos no Brasil tendem a atrair capital estrangeiro (ganho com a diferença de juros), o que costuma pressionar o dólar para baixo. Juros em queda têm o efeito contrário.',
    'Muda o custo do crédito, do capital de giro e do financiamento de importações; afeta o custo de proteção cambial (hedge).'),
  t('inflacao_br', 'Inflação no Brasil', 50, /\b(ipca|inpc|igp-?m|inflacao|indice de precos)\b/,
    'Inflação acima do esperado pode levar o Banco Central a manter juros altos por mais tempo, o que em geral sustenta o real; o efeito final é incerto.',
    'Influencia reajustes de contratos (IGP-M/IPCA), custos de insumos e a política de preços.'),
  t('fiscal', 'Política fiscal e contas públicas', 55, /\b(arcabouco fiscal|meta fiscal|deficit (fiscal|primario|nominal|publico)|superavit (fiscal|primario|nominal)|(deficit|rombo)\b.{0,30}\b(contas|governo|orcamento|tesouro)|divida publica|resultado primario|gastos? publicos?|teto de gastos|risco fiscal|orcamento|contas publicas|ajuste fiscal)\b/,
    'Dúvidas sobre as contas públicas elevam o prêmio de risco do país e costumam enfraquecer o real; sinais de ajuste fiscal tendem a ter o efeito oposto.',
    'Pode encarecer o crédito e o câmbio ao mesmo tempo; relevante para planejamento de custos e preços de importados.'),
  t('emprego_atividade', 'Atividade e emprego', 35, /\b(pib|desemprego|caged|taxa de desocupacao|producao industrial|vendas no varejo|payroll|empregos?)\b/,
    'Indicadores de atividade e emprego alteram a expectativa de juros (no Brasil e no exterior) e, indiretamente, o câmbio. O efeito costuma ser pequeno e incerto isoladamente.',
    'Sinaliza demanda e ritmo de vendas; pode antecipar mudanças no custo de crédito.'),
  t('juros_ext', 'Juros e política monetária no exterior', 55, /\b(federal reserve|\bfed\b|fomc|powell|banco central europeu|\bbce\b|treasur(y|ies)|juros (nos|dos) (eua|estados unidos)|taxa de juros americana)\b/,
    'Juros mais altos nos EUA tornam o dólar mais atrativo no mundo todo e costumam pressionar moedas emergentes, como o real. Cortes de juros nos EUA tendem a aliviar essa pressão.',
    'Afeta o custo do dólar para importadores, dívidas em moeda estrangeira e a atratividade de exportar.'),
  t('commodities', 'Petróleo e commodities', 40, /\b(petroleo|brent|\bwti\b|minerio de ferro|commodit(y|ies)|soja|opep|\bopec\b|preco do cobre)\b/,
    'O Brasil exporta commodities: preços internacionais mais altos tendem a trazer mais dólares ao país (pressão de baixa sobre o dólar) e preços mais baixos, o contrário. O efeito é indireto.',
    'Afeta custos de combustíveis e insumos, e a receita de exportadores de commodities.'),
  t('geopolitica', 'Conflitos, sanções e comércio', 45, /\b(guerra|conflito|sancoes|sancao|tarifaco|tarifas? (de importacao|sobre|comerciais|americanas|dos eua|do trump|contra)|disputa comercial|guerra comercial|embargo|cessar-?fogo|ataque militar|tensao geopolitica)\b/,
    'Em momentos de tensão global, investidores buscam ativos considerados seguros, como o dólar, e reduzem a exposição a países emergentes, o que costuma pressionar o real.',
    'Pode afetar cadeias de suprimento, custos de frete e seguros, tarifas sobre importações/exportações e preços de insumos.'),
  t('eleicoes', 'Eleições e política', 40, /\b(eleicao|eleicoes|pesquisa eleitoral|candidat[oa]s?|segundo turno|primeiro turno|reforma ministerial)\b/,
    'Incerteza política pode aumentar a volatilidade do câmbio, sobretudo quando afeta a expectativa sobre o rumo fiscal e econômico.',
    'Eleva a incerteza para investimentos e contratos de longo prazo; pode justificar mais cautela na proteção cambial.'),
  t('china', 'Economia da China', 35, /\b(china|chines(a|es)?|yuan|renminbi|pequim)\b.{0,80}\b(economia|pib|exportac|importac|demanda|industria|crescimento|juros|crise)\b/,
    'A China é o maior parceiro comercial do Brasil: sua demanda influencia o preço do que o Brasil exporta (minério, soja, petróleo) e o apetite global por risco.',
    'Afeta exportadores de commodities e importadores de produtos e insumos chineses.'),
  t('argentina', 'Argentina', 30, /\b(argentina|argentin[oa]s?|peso argentino|milei|buenos aires)\b.{0,80}\b(economia|cambio|inflacao|peso|reservas|fmi|crise|dolar)\b/,
    'A Argentina é parceira comercial relevante do Brasil; crises cambiais por lá afetam as exportações brasileiras (especialmente de manufaturados) e a condição de pagamento de clientes.',
    'Relevante para exportadores ao Mercosul: risco de pagamento, restrições cambiais e competitividade.'),
  t('cambio', 'Câmbio e dólar', 45, /\b(dolar|cambio|real desvaloriz|real valoriz|moeda brasileira|cotacao)\b/,
    'Notícia direta sobre o mercado de câmbio. Variações do dólar costumam refletir vários fatores ao mesmo tempo.',
    'Impacta o custo de importados, a receita de exportadores e dívidas em moeda estrangeira.'),
  t('tributario', 'Reforma tributária e tributos', 50, /\b(reforma tributaria|\bibs\b|\bcbs\b|imposto seletivo|simples nacional|\bmei\b|lucro presumido|lucro real|receita federal|nota fiscal|icms|\biss\b|regulamentacao tributaria|comite gestor)\b/,
    'Tema tributário: sem efeito direto sobre o câmbio. Relevante pelo impacto em custos, preços e obrigações das empresas.',
    'Pode mudar alíquotas, obrigações acessórias, prazos e a forma de apurar tributos; veja a aba Reforma e legislação.'),
];

const NO_EFFECT = new Set(['tributario']);

const rx = (s) => new RegExp(s);
const UP = '(eleva|elevou|aumenta|aumentou|sobe|subiu|alta|dispara|disparou|acelera|acelerou)';
const DOWN = '(corta|cortou|reduz|reduziu|diminui|diminuiu|cai|caiu|queda|recua|recuou|desacelera|desacelerou|despenca)';

// Direção do efeito SOBRE O DÓLAR frente ao real, por tema. Só emite sinal quando a frase é clara.
const DIRECTION_RULES = {
  juros_br: [
    { re: rx(`\\b${UP}\\b.{0,40}\\b(selic|juros|taxa basica)\\b|\\b(selic|juros)\\b.{0,30}\\b(sobe|subiu|em alta|mais altos?)\\b`), dir: 'baixa', why: 'Alta de juros no Brasil tende a atrair capital e sustentar o real.' },
    { re: rx(`\\b${DOWN}\\b.{0,40}\\b(selic|juros|taxa basica)\\b`), dir: 'alta', why: 'Queda de juros no Brasil reduz a atratividade do real e tende a favorecer o dólar.' },
  ],
  juros_ext: [
    { re: rx(`\\b${UP}\\b.{0,40}\\b(juros|taxa)\\b|\\bjuros (altos|elevados)\\b|\\b(mantem|manteve)\\b.{0,30}\\bjuros altos\\b`), dir: 'alta', why: 'Juros mais altos no exterior fortalecem o dólar globalmente.' },
    { re: rx(`\\b${DOWN}\\b.{0,40}\\b(juros|taxa)\\b`), dir: 'baixa', why: 'Corte de juros no exterior tende a enfraquecer o dólar globalmente.' },
  ],
  commodities: [
    { re: rx(`\\b(petroleo|brent|minerio|soja|commodit\\w+)\\b.{0,40}\\b${UP}\\b|\\b${UP}\\b.{0,30}\\b(petroleo|brent|minerio|soja)\\b`), dir: 'baixa', why: 'Preço de commodities em alta tende a elevar a entrada de dólares no Brasil (efeito indireto).' },
    { re: rx(`\\b(petroleo|brent|minerio|soja|commodit\\w+)\\b.{0,40}\\b${DOWN}\\b|\\b${DOWN}\\b.{0,30}\\b(petroleo|brent|minerio|soja)\\b`), dir: 'alta', why: 'Preço de commodities em queda tende a reduzir a entrada de dólares no Brasil (efeito indireto).' },
  ],
  fiscal: [
    { re: /\b(deficit (fiscal|primario|nominal|publico)|rombo (fiscal|nas contas|do governo)|estouro|risco fiscal|furar|descumpr\w+|aumento (de|dos) gastos)\b/, dir: 'alta', why: 'Piora esperada das contas públicas eleva o prêmio de risco e tende a pressionar o real.' },
    { re: /\b(superavit (fiscal|primario|nominal)|corte de gastos|ajuste fiscal|meta cumprida|equilibrio fiscal)\b/, dir: 'baixa', why: 'Sinal de ajuste fiscal reduz o prêmio de risco e tende a favorecer o real.' },
  ],
  geopolitica: [
    { re: /\b(guerra|conflito|ataque|sancoes?|tarifaco|tarifas? (de importacao|sobre|comerciais|americanas|dos eua|do trump|contra)|guerra comercial|embargo|tensao)\b/, dir: 'alta', why: 'Tensão global eleva a aversão a risco e favorece o dólar frente a moedas emergentes.' },
    { re: /\b(cessar-?fogo|acordo (de paz|comercial)|trégua|tregua)\b/, dir: 'baixa', why: 'Redução de tensões diminui a aversão a risco e tende a aliviar o dólar.' },
  ],
};

const LEVELS = [[75, 'alta'], [50, 'media'], [0, 'baixa']];
const levelOf = (n) => LEVELS.find(([min]) => n >= min)[1];

export function detectTopics(text) {
  const norm = stripAccents(text).toLowerCase();
  return TOPICS.filter((tp) => tp.re.test(norm));
}

/**
 * Analisa uma notícia. Separa FATOS (dados da publicação) de INTERPRETAÇÃO (regras do sistema).
 * item: { title, summary, source, url, publishedAt, official, region }
 */
export function analyzeNews(item, now = new Date(), forceTopic = null) {
  const text = `${item.title}. ${item.summary || ''}`;
  let topics = detectTopics(text);
  if (forceTopic && !topics.some((x) => x.id === forceTopic)) topics = [...topics, TOPICS.find((x) => x.id === forceTopic)];
  if (!topics.length) return null;
  // Tema só no resumo e um único: ruído (ex.: "conflito" num texto sobre saúde). Exige tema no título ou ao menos dois temas.
  if (!forceTopic && topics.length < 2 && !detectTopics(item.title).length) return null;

  const norm = stripAccents(text).toLowerCase();
  const titleNorm = stripAccents(item.title).toLowerCase();

  // Direção: sinais por tema
  const signals = [];
  for (const tp of topics) {
    for (const r of DIRECTION_RULES[tp.id] || []) if (r.re.test(norm)) { signals.push({ topic: tp.label, dir: r.dir, why: r.why }); break; }
  }
  const dirs = new Set(signals.map((s) => s.dir));
  let direction = 'incerto', conf = 'baixa', nota = null;
  if (dirs.size === 1) { direction = [...dirs][0]; conf = signals.length > 1 ? 'media' : 'baixa'; }
  else if (dirs.size > 1) nota = 'Sinais opostos na mesma notícia: o efeito líquido é incerto.';
  else if (topics.every((x) => NO_EFFECT.has(x.id))) nota = 'Tema tributário: sem efeito cambial direto identificado.';
  else nota = 'Sem sinal claro de direção no texto: efeito incerto.';

  // Relevância 0–100
  const maxW = Math.max(...topics.map((x) => x.weight));
  let score = maxW + Math.min(20, (topics.length - 1) * 8);
  if (item.official) score += 10;
  if (!detectTopics(item.title).length) score -= 15; // tema só aparece no resumo: menos relevante
  if (/\b(dolar|cambio|real)\b/.test(titleNorm)) score += 10;
  if (item.publishedAt && now - new Date(item.publishedAt) < 6 * 3600e3) score += 5;
  score = Math.min(100, score);

  const analysis = {
    metodo: 'regras',
    fatos: {
      o_que: item.title,
      resumo_da_fonte: (item.summary || '').slice(0, 500) || null,
      quando: item.publishedAt || null,
      fonte: item.source,
      link: item.url,
    },
    interpretacao: {
      aviso: 'Interpretação automática por regras do sistema, a partir do título e do resumo publicados. Não é fato confirmado, não é previsão e não indica que esta notícia causou qualquer variação da cotação. Vários fatores atuam ao mesmo tempo no câmbio.',
      temas: topics.map((x) => x.label),
      por_que_pode_influenciar: topics.map((x) => ({ tema: x.label, texto: x.why })),
      efeito_empresas: topics.map((x) => ({ tema: x.label, texto: x.empresas })),
      direcao_dolar_real: direction,
      motivos_direcao: signals.map((s) => `${s.topic}: ${s.why}`),
      confianca: conf,
      nota,
    },
  };

  return { topics: topics.map((x) => x.id), relevance: score, level: levelOf(score), direction, analysis };
}

export const TOPIC_LIST = TOPICS.map(({ id, label }) => ({ id, label }));
