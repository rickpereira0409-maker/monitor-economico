import { fill, h, s, ext, api, initMode, fmtNum, fmtPct, fmtDT, fmtD, fmtDay, ago, sparkline, lineChart } from './lib.js';
import { applyLive, livePairs } from './static-api.js';
import { simulate, simulateReceipt, checkConfirmation, PRESETS } from './calc.js';
import { parseInvoice } from './invoice.js';
import { readPdf } from './pdf-text.js';
import { PAISES_LISTA, NATUREZAS, STATUS, FONTES, OUTROS, EXPORTACAO, IBS_CBS, sugerirIR, calcOutros } from './tributos.js';

const CH_LABEL = { inapp: 'No painel', email: 'E-mail', telegram: 'Telegram', ntfy: 'Celular (ntfy)' };

const app = document.getElementById('app');
const state = { meta: null, status: null, prefs: null, fxType: {}, news: { level: '', direction: '', topic: '', q: '', official: false }, legis: null, timer: null, live: null, static: false };

const DIR = { alta: 'Pressão de ALTA sobre o dólar', baixa: 'Pressão de BAIXA sobre o dólar', incerto: 'Efeito incerto sobre o dólar' };
const LEVEL = { alta: 'Relevância alta', media: 'Relevância média', baixa: 'Relevância baixa' };
const SETORES = ['Indústria', 'Comércio', 'Serviços', 'Agropecuária', 'Construção', 'Transporte e logística', 'Tecnologia', 'Saúde', 'Educação', 'Financeiro', 'Energia e combustíveis'];
const KINDS = { cambio: 'Câmbio', noticia: 'Notícia', legislacao: 'Legislação', prazo: 'Prazo', resumo: 'Resumo' };
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

const term = (name, label) => {
  const tip = state.meta?.glossary?.[name];
  return tip ? h('abbr', { class: 'term', title: tip, tabindex: 0 }, label || name) : (label || name);
};
const chip = (text, cls = '') => h('span', { class: `chip ${cls}` }, text);
const banner = (cls, ...kids) => h('div', { class: `banner ${cls}`, role: cls === 'bad' ? 'alert' : 'status' }, ...kids);
const demoChip = () => chip('DEMONSTRAÇÃO', 'demo');
const errBox = (e) => banner('bad', `Não foi possível carregar: ${e.message}`);

async function toggleFav(kind, ref, on) { await api('/favorites', { method: 'POST', body: { kind, ref: String(ref), on } }); }
function favBtn(kind, ref, initial) {
  let on = initial;
  const b = h('button', { class: 'icon-btn', type: 'button', 'aria-pressed': String(on), title: 'Favoritar', 'aria-label': 'Favoritar' }, on ? '★' : '☆');
  b.addEventListener('click', async () => {
    try { on = !on; await toggleFav(kind, ref, on); b.setAttribute('aria-pressed', String(on)); b.textContent = on ? '★' : '☆'; } catch (e) { on = !on; alert(e.message); }
  });
  return b;
}

// =============== Estrutura ===============
const ROUTES = [
  ['moedas', 'Moedas'], ['noticias', 'Notícias'], ['legislacao', 'Reforma e legislação'], ['agenda', 'Agenda e prazos'], ['simulador', 'Simulador de remessa'], ['tributos', 'Tributos por país'],
  ['alertas', 'Alertas'], ['favoritos', 'Favoritos'], ['config', 'Configurações'],
];

function renderShell() {
  app.replaceChildren(
    h('header', { class: 'top' },
      h('div', { class: 'top-in' },
        h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, s('svg', { viewBox: '0 0 32 32' }, s('path', { d: 'M6 21l6-7 5 4 9-11', fill: 'none', stroke: '#fff', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))), 'Monitor Econômico e Tributário'),
        h('span', { id: 'marketchip' }),
        state.status?.authRequired ? h('button', { class: 'btn small', type: 'button', onclick: async () => { await api('/logout', { method: 'POST' }).catch(() => {}); location.reload(); } }, 'Sair') : null),
      h('nav', { class: 'tabs', 'aria-label': 'Seções' }, ROUTES.map(([id, label]) => h('a', { href: `#/${id}`, id: `tab-${id}` }, label, id === 'alertas' ? h('span', { class: 'count', id: 'unread', hidden: true }) : null)))),
    h('div', { class: 'shell' }, h('div', { id: 'notices' }), h('main', { id: 'main', tabindex: -1 })));
}

function renderNotices() {
  const st = state.status, box = document.getElementById('notices');
  if (!st || !box) return;
  const out = [];
  if (st.demo) out.push(banner('demo', 'Há dados de DEMONSTRAÇÃO no sistema (marcados como tal). Não são dados reais.'));
  const ageMin = st.generatedAt ? (Date.now() - new Date(st.generatedAt).getTime()) / 60000 : 0;
  if (ageMin > 90) out.push(banner('warn', h('strong', null, 'Dados desatualizados: '), `a última coleta automática foi ${ago(st.generatedAt)}. O agendamento do GitHub pode estar pausado ou com falha: abra a aba Actions do repositório e reative.`));
  const bad = st.jobs.filter((j) => j.consecutiveFailures >= 2 || (j.stale && j.lastRunAt));
  if (bad.length) out.push(banner('warn', h('strong', null, 'Algumas fontes estão com problema: '), bad.map((j) => `${j.label}${j.lastOkAt ? ` (última coleta bem-sucedida ${ago(j.lastOkAt)})` : ' (nunca coletou)'}`).join('; '), '. Os dados dessas áreas podem estar desatualizados.'));
  box.replaceChildren(...out);
  const chipEl = document.getElementById('marketchip');
  if (chipEl) { chipEl.replaceChildren(chip(st.market.label, st.market.open ? 'ok' : ''));  chipEl.title = st.market.reason; }
  const u = document.getElementById('unread');
  if (u) { u.hidden = !st.unreadAlerts; u.textContent = st.unreadAlerts; }
}

async function refreshStatus() { try { state.status = await api('/status'); renderNotices(); } catch { /* sessão expirada tratada em auth-required */ } }

// =============== Moedas ===============
function fxCard(c, onChange) {
  const avail = (c.types || []).filter((t) => t.available);
  const card = h('article', { class: 'card' });
  if (!avail.length) {
    card.append(h('div', { class: 'fx-head' }, h('div', null, h('div', { class: 'fx-pair' }, c.pair), h('div', { class: 'muted small' }, c.name))), h('p', { class: 'muted' }, 'Aguardando a primeira coleta de dados desta moeda…'));
    return card;
  }
  const cur = avail.find((t) => t.type === state.fxType[c.code]) || avail.find((t) => t.type === 'comercial') || avail[0];
  const up = cur.changePct > 0;
  fill(card,
    h('div', { class: 'fx-head' },
      h('div', null, h('div', { class: 'fx-pair' }, c.pair), h('div', { class: 'muted small' }, c.name)),
      favBtn('currency', c.code, c.favorite)),
    h('div', { class: 'seg', role: 'group', 'aria-label': `Tipo de cotação de ${c.code}` }, avail.map((t) => h('button', { type: 'button', 'aria-pressed': String(t.type === cur.type), onclick: () => { state.fxType[c.code] = t.type; onChange(); } }, t.short))),
    h('div', { class: 'fx-value' }, `R$ ${fmtNum(cur.value, c.decimals)}`),
    h('div', null,
      cur.changePct == null ? h('span', { class: 'muted small' }, 'Sem fechamento anterior para comparar.')
        : [h('span', { class: `delta ${up ? 'up' : 'down'}` }, `${up ? '▲' : cur.changePct < 0 ? '▼' : '•'} ${fmtPct(cur.changePct)}`),
          h('span', { class: 'muted small' }, ` sobre o fechamento de ${fmtDay(cur.prevDate)} (R$ ${fmtNum(cur.prevClose, c.decimals)})`)]),
    sparkline(cur.spark),
    cur.stale ? banner('warn', cur.staleNote) : null,
    h('dl', { class: 'meta' },
      h('dt', null, 'Tipo'), h('dd', null, cur.type === 'ptax' ? term('PTAX', cur.label) : cur.type === 'comercial' ? term('Dólar comercial', cur.label) : term('Dólar turismo', cur.label)),
      h('dt', null, 'Fonte'), h('dd', null, cur.source),
      h('dt', null, 'Cotação de'), h('dd', null, `${fmtDT(cur.quoteTs)} (Brasília) · ${ago(cur.quoteTs)}`),
      cur.boletim ? [h('dt', null, 'Boletim'), h('dd', null, cur.boletim)] : null,
      cur.ask && cur.type === 'comercial' ? [h('dt', null, 'Venda (ask)'), h('dd', null, `R$ ${fmtNum(cur.ask, c.decimals)}`)] : null),
    !c.hasPtax ? h('p', { class: 'muted small' }, `Sem PTAX: o Banco Central não publica taxa de referência para ${c.code}. Só há cotação de mercado.`) : null,
    h('details', { class: 'explain' }, h('summary', null, 'O que é este tipo de cotação?'), h('p', { class: 'small' }, cur.desc)),
    h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => openHistory(c, cur.type) }, 'Histórico e gráfico')));
  return card;
}

async function viewMoedas(main) {
  const data = await api('/currencies');
  const grid = h('div', { class: 'grid' });
  const draw = () => grid.replaceChildren(...data.currencies.filter((c) => c.active).map((c) => fxCard(c, draw)));
  draw();
  const liveNote = h('p', { class: 'small', role: 'status' });
  clearInterval(state.live);
  if (state.static) {
    const poll = async () => {
      try {
        const r = await fetch(`https://economia.awesomeapi.com.br/json/last/${livePairs(data).join(',')}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const n = applyLive(data, await r.json());
        liveNote.textContent = n ? `Mercado ao vivo (AwesomeAPI), consultado pelo seu celular às ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })} e renovado a cada 30 s. A PTAX e os demais dados vêm da coleta automática (${ago(state.status?.generatedAt)}).` : `Sem cotação de mercado mais nova que a última coleta (${ago(state.status?.generatedAt)}).`;
        if (n) draw();
      } catch { liveNote.textContent = 'Não foi possível consultar as cotações ao vivo agora. Mostrando a última coleta automática.'; }
    };
    poll(); state.live = setInterval(poll, 30000);
  }
  fill(main, 
    h('h1', null, 'Moedas'),
    h('p', { class: 'lead' }, 'Cotações frente ao real. Cada cartão mostra um tipo de cotação por vez; ', term('PTAX'), ', ', term('Dólar comercial', 'comercial'), ' e ', term('Dólar turismo', 'turismo'), ' são valores diferentes e nunca são misturados. Os dados não são em tempo real: a coleta acontece a cada poucos minutos.'),
    h('div', { class: 'row' }, chip(data.market.label, data.market.open ? 'ok' : ''), h('span', { class: 'muted small' }, data.market.reason)),
    liveNote,
    grid,
    h('p', { class: 'muted small' }, 'Variação = cotação atual comparada ao último fechamento diário do mesmo tipo de cotação. Mercado: AwesomeAPI (agregador, não oficial). Referência: Banco Central do Brasil (PTAX). Para ativar outras moedas, vá em Configurações.'));
}

async function openHistory(c, type0) {
  const dlg = h('dialog', { 'aria-label': `Histórico ${c.pair}` });
  let type = type0, range = '30d';
  const body = h('div');
  const load = async () => {
    fill(body, h('p', { class: 'muted' }, 'Carregando…'));
    try {
      const d = await api(`/currencies/${c.code}/history?type=${type}&range=${range}`);
      fill(body, 
        h('p', { class: 'small muted' }, `${d.label} · ${d.granularity}`),
        lineChart(d.points, { decimals: c.decimals, intraday: range === '1d' }),
        d.stats ? h('p', { class: 'small' }, `Mínimo R$ ${fmtNum(d.stats.min, c.decimals)} · Máximo R$ ${fmtNum(d.stats.max, c.decimals)} · Variação no período ${fmtPct(d.stats.changePct)}`) : null);
    } catch (e) { fill(body, errBox(e)); }
  };
  const types = (c.types || []).filter((t) => t.available).map((t) => t.type);
  const seg = (items, get, set) => h('div', { class: 'seg' }, items.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(get() === v), onclick: (e) => { set(v); e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); load(); } }, l)));
  dlg.append(
    h('div', { class: 'row' }, h('h2', { class: 'grow' }, `${c.pair} — ${c.name}`), h('button', { class: 'btn small', type: 'button', onclick: () => dlg.close() }, 'Fechar')),
    h('div', { class: 'row' },
      seg(types.map((t) => [t, { ptax: 'PTAX', comercial: 'Comercial', turismo: 'Turismo' }[t]]), () => type, (v) => { type = v; }),
      seg([['1d', '24 h'], ['7d', '7 dias'], ['30d', '30 dias'], ['90d', '90 dias'], ['365d', '1 ano']], () => range, (v) => { range = v; })),
    body);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal(); load();
}

// =============== Notícias ===============
function newsCard(n) {
  const a = n.analysis, i = a?.interpretacao, f = a?.fatos;
  return h('article', { class: 'card item' },
    h('div', { class: 'row' },
      h('div', { class: 'tags grow' }, chip(LEVEL[n.level] || n.level, n.level === 'alta' ? 'warn' : ''), n.official ? chip('Fonte oficial', 'info') : null, n.revision > 1 ? chip(`Atualizada (versão ${n.revision})`, 'info') : null, n.isDemo ? demoChip() : null),
      favBtn('news', n.id, n.favorite)),
    h('h3', null, ext(n.url, n.title)),
    h('div', { class: 'muted small' }, `${n.source} · ${n.publishedAt ? fmtDT(n.publishedAt) + ' (Brasília)' : 'data de publicação não informada'}`),
    h('div', { class: 'facts' },
      h('div', { class: 'label-kicker' }, 'O que foi publicado (fato, segundo a fonte)'),
      h('p', { class: 'small' }, f?.resumo_da_fonte || 'A fonte não trouxe resumo. Abra a publicação original.'),
      ext(n.url, 'Abrir publicação original ↗', 'small')),
    h('div', { class: 'interp' },
      h('div', { class: 'label-kicker' }, 'Interpretação automática (não é fato nem previsão)'),
      h('div', { class: 'tags' }, h('span', { class: `chip dir-${n.direction}` }, DIR[n.direction]), ...n.topics.map((t) => chip(state.meta.topics.find((x) => x.id === t)?.label || t))),
      i?.nota ? h('p', { class: 'small muted' }, i.nota) : null,
      h('details', { class: 'explain' },
        h('summary', null, 'Por que isso pode influenciar o câmbio e as empresas'),
        h('div', { class: 'stack small' },
          ...(i?.por_que_pode_influenciar || []).map((x) => h('p', null, h('strong', null, `${x.tema}: `), x.texto)),
          h('p', null, h('strong', null, 'Possível efeito sobre empresas brasileiras: ')), ...(i?.efeito_empresas || []).map((x) => h('p', null, `• ${x.texto}`)),
          i?.motivos_direcao?.length ? h('p', null, h('strong', null, 'Sinais que levaram a esta direção: '), i.motivos_direcao.join(' ')) : null,
          h('p', { class: 'muted' }, `Confiança da regra: ${i?.confianca || 'baixa'}. ${i?.aviso || ''}`)))));
}

async function viewNoticias(main) {
  const F = state.news;
  const list = h('div', { class: 'stack' });
  const load = async () => {
    list.replaceChildren(h('p', { class: 'muted' }, 'Carregando…'));
    const q = new URLSearchParams(Object.entries({ level: F.level, direction: F.direction, topic: F.topic, q: F.q, official: F.official ? '1' : '' }).filter(([, v]) => v));
    try {
      const items = await api(`/news?${q}`);
      list.replaceChildren(...(items.length ? items.map(newsCard) : [h('p', { class: 'muted' }, 'Nenhuma notícia com esses filtros. O sistema coleta novas publicações a cada ~20 minutos.')]));
    } catch (e) { list.replaceChildren(errBox(e)); }
  };
  const sel = (label, key, opts) => h('label', { class: 'field' }, label, h('select', { onchange: (e) => { F[key] = e.target.value; load(); } }, opts.map(([v, l]) => h('option', { value: v, selected: F[key] === v }, l))));
  fill(main, 
    h('h1', null, 'Notícias que podem influenciar o câmbio'),
    h('p', { class: 'lead' }, 'Acontecimentos no Brasil e no exterior. Cada cartão separa o que a fonte publicou (fato) da interpretação automática do sistema, que é uma explicação geral do mecanismo econômico: ela não prova que a notícia causou qualquer oscilação e vários fatores atuam ao mesmo tempo.'),
    h('div', { class: 'filters' },
      sel('Relevância', 'level', [['', 'Todas'], ['alta', 'Alta'], ['media', 'Média'], ['baixa', 'Baixa']]),
      sel('Efeito sobre o dólar', 'direction', [['', 'Qualquer'], ['alta', 'Pressão de alta'], ['baixa', 'Pressão de baixa'], ['incerto', 'Incerto']]),
      sel('Assunto', 'topic', [['', 'Todos'], ...state.meta.topics.map((t) => [t.id, t.label])]),
      h('label', { class: 'field' }, 'Buscar', h('input', { type: 'text', value: F.q, placeholder: 'palavra no título', oninput: (e) => { F.q = e.target.value; clearTimeout(viewNoticias.t); viewNoticias.t = setTimeout(load, 350); } })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: F.official, onchange: (e) => { F.official = e.target.checked; load(); } }), 'Só fontes oficiais')),
    list);
  load();
}

// =============== Legislação ===============
function stageSteps(item) {
  const stages = state.meta.stages.slice(0, 5); // etapas que a API oficial permite inferir; as demais dependem de conferência manual
  const idx = Math.min(stages.findIndex((x) => x.id === item.stage), 4);
  const cur = item.stage === 'proposta' || item.stage === 'comissao' || item.stage === 'aprovada_casa' || item.stage === 'aprovacao_legislativa' || item.stage === 'sancionada' ? idx : 4;
  return h('ol', { class: 'steps', 'aria-label': `Etapa: ${item.stageLabel}` }, stages.map((st, i) => h('li', { class: i < cur ? 'done' : i === cur ? 'cur' : '', title: st.label })));
}

function legisCard(it) {
  const chips = (list, empty) => (list.length && !list.includes('indeterminado') ? list.map((x) => chip(x === 'todos' || x === 'todas' ? (x === 'todos' ? 'Todos' : 'Todo o país') : x)) : [chip(empty, 'warn')]);
  const events = h('div');
  let loaded = false;
  return h('article', { class: 'card item' },
    h('div', { class: 'row' },
      h('div', { class: 'tags grow' }, chip(`${it.sigla} ${it.numero}/${it.ano}`), it.curated ? chip('Acompanhada pelo sistema', 'info') : chip('Descoberta automática', ''), it.isDemo ? demoChip() : null,
        it.special ? chip({ arquivada: 'Arquivada', retirada: 'Retirada', rejeitada: 'Rejeitada', veto: 'Com veto' }[it.special] || it.special, 'bad') : null),
      favBtn('legis', it.id, it.favorite)),
    h('h3', null, it.title),
    it.ementa ? h('p', { class: 'small' }, it.ementa) : null,
    h('div', null, h('div', { class: 'tags' }, chip(it.stageLabel, it.isLaw ? 'ok' : 'warn')), stageSteps(it),
      it.isLaw
        ? banner('info', h('strong', null, 'Norma publicada'), it.norma ? `: ${it.norma}.` : '.', ' ', 'A entrada em vigor e o início dos efeitos podem ter datas próprias e regulamentação pendente: confira os prazos no texto da norma.')
        : banner('warn', h('strong', null, 'Ainda não é regra vigente. '), it.stageHelp)),
    h('dl', { class: 'meta' },
      h('dt', null, 'Situação'), h('dd', null, `${it.situacao || 'não informada'}${it.orgao ? ` (${it.orgao})` : ''}`),
      h('dt', null, 'Última movimentação'), h('dd', null, `${it.lastMoveAt ? fmtDT(it.lastMoveAt) : '—'}${it.lastMoveText ? ` — ${it.lastMoveText.slice(0, 280)}` : ''}`),
      h('dt', null, 'Tributos'), h('dd', null, it.tributos.length ? it.tributos.join(', ') : 'Não identificados automaticamente')),
    h('div', { class: 'stack small' },
      h('div', null, h('strong', null, 'Empresas potencialmente afetadas: '), h('span', { class: 'tags' }, ...chips(it.regimes, 'Regime: não determinado'))),
      h('div', null, h('strong', null, 'Setores: '), h('span', { class: 'tags' }, ...chips(it.setores, 'Setor: não determinado'))),
      h('div', null, h('strong', null, 'Localização: '), h('span', { class: 'tags' }, ...chips(it.ufs, 'UF: não determinada'))),
      it.notes ? h('p', null, h('strong', null, it.curated ? 'Leitura editorial (não oficial): ' : 'Atenção: '), it.notes) : null,
      it.watch ? h('p', null, h('strong', null, 'O que acompanhar: '), it.watch) : null),
    h('div', { class: 'row small' }, ext(it.officialUrl, 'Ficha de tramitação oficial (Câmara) ↗'), it.textUrl ? ext(it.textUrl, 'Texto/inteiro teor ↗') : null),
    h('details', { class: 'explain', ontoggle: async (e) => {
      if (!e.target.open || loaded) return; loaded = true;
      try { const d = await api(`/legislation/${encodeURIComponent(it.id)}/events`); events.replaceChildren(h('ul', { class: 'timeline' }, d.events.map((ev) => h('li', null, h('strong', null, `${fmtD(ev.ts)} · ${ev.orgao || ''}`), h('div', null, (ev.descricao || ev.situacao || '').slice(0, 320)))))); } catch (err) { events.replaceChildren(errBox(err)); }
    } }, h('summary', null, 'Histórico de tramitação'), events));
}

async function viewLegislacao(main) {
  const p = state.prefs.profile || {};
  const F = state.legis || (state.legis = { regime: p.regime || '', setor: p.setor || '', uf: p.uf || '', stage: '', onlyCurated: true, hideUndetermined: false });
  const list = h('div', { class: 'stack' });
  const load = async () => {
    list.replaceChildren(h('p', { class: 'muted' }, 'Carregando…'));
    const q = new URLSearchParams(Object.entries({ regime: F.regime, setor: F.setor, uf: F.uf, stage: F.stage, onlyCurated: F.onlyCurated ? '1' : '', hideUndetermined: F.hideUndetermined ? '1' : '' }).filter(([, v]) => v));
    try {
      const items = await api(`/legislation?${q}`);
      list.replaceChildren(...(items.length ? items.map(legisCard) : [h('p', { class: 'muted' }, 'Nenhuma proposição ou norma com esses filtros. Os dados são carregados pela primeira coleta (alguns segundos após iniciar o servidor).')]));
    } catch (e) { list.replaceChildren(errBox(e)); }
  };
  const sel = (label, key, opts) => h('label', { class: 'field' }, label, h('select', { onchange: (e) => { F[key] = e.target.value; load(); } }, opts.map(([v, l]) => h('option', { value: v, selected: F[key] === v }, l))));
  fill(main, 
    h('h1', null, 'Reforma tributária e legislação'),
    h('p', { class: 'lead' }, 'Situação de projetos e normas que afetam empresas, a partir da API de dados abertos da Câmara dos Deputados. O sistema diferencia proposta, aprovação em comissão ou em uma das Casas, aprovação legislativa e sanção/publicação. Projeto em tramitação ', h('strong', null, 'não é regra vigente'), '.'),
    h('div', { class: 'filters' },
      sel('Regime tributário', 'regime', [['', 'Todos'], ...state.meta.regimes.map((r) => [r, r])]),
      sel('Setor', 'setor', [['', 'Todos'], ...SETORES.map((r) => [r, r])]),
      sel('Estado (UF)', 'uf', [['', 'Todos'], ...state.meta.ufs.map((r) => [r, r])]),
      sel('Etapa', 'stage', [['', 'Todas'], ...state.meta.stages.slice(0, 5).map((x) => [x.id, x.label])]),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: F.onlyCurated, onchange: (e) => { F.onlyCurated = e.target.checked; load(); } }), 'Só as acompanhadas pelo sistema'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: F.hideUndetermined, onchange: (e) => { F.hideUndetermined = e.target.checked; load(); } }), 'Ocultar aplicação não determinada')),
    banner('info', 'Quando o sistema não consegue determinar se uma regra se aplica ao seu regime, setor ou estado, isso aparece explicitamente como "não determinado" em vez de ser omitido. A classificação por regime/setor/UF é editorial e simplificada: confirme sempre na fonte oficial.'),
    list,
    h('p', { class: 'muted small' }, 'Limitação: as etapas "em regulamentação" e "em vigor" não são inferidas automaticamente (a API não as informa de forma estruturada). Normas do Planalto, Diário Oficial da União e atos da Receita Federal devem ser conferidos diretamente nas fontes oficiais; notícias da Receita Federal aparecem na seção Notícias.'));
  load();
}

// =============== Agenda ===============
async function viewAgenda(main) {
  const d = await api('/agenda');
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { await api('/deadlines', { method: 'POST', body: Object.fromEntries(f) }); viewAgenda(main); } catch (err) { alert(err.message); }
  } },
    h('h3', null, 'Adicionar prazo ou evento'),
    h('div', { class: 'filters' },
      h('label', { class: 'field' }, 'Título', h('input', { type: 'text', name: 'title', required: true, maxlength: 160 })),
      h('label', { class: 'field' }, 'Data', h('input', { type: 'date', name: 'date', required: true })),
      h('label', { class: 'field' }, 'Tipo', h('select', { name: 'kind' }, [['prazo', 'Prazo'], ['obrigacao', 'Obrigação'], ['vigencia', 'Início de vigência'], ['evento', 'Evento']].map(([v, l]) => h('option', { value: v }, l)))),
      h('label', { class: 'field' }, 'Link da fonte oficial', h('input', { type: 'text', name: 'sourceUrl', placeholder: 'https://…' }))),
    h('label', { class: 'field' }, 'Descrição (opcional)', h('input', { type: 'text', name: 'description', maxlength: 600 })),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Adicionar'), h('span', { class: 'muted small' }, 'Você receberá lembretes conforme a regra "Lembretes de prazos".')));
  const row = (x) => h('div', { class: 'card alert-row' },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, x.title), x.isDemo ? demoChip() : null, chip(x.daysLeft === 0 ? 'HOJE' : x.daysLeft > 0 ? `em ${x.daysLeft} dia(s)` : `há ${-x.daysLeft} dia(s)`, x.daysLeft >= 0 && x.daysLeft <= 3 ? 'warn' : ''), chip(fmtDay(x.date))),
    x.description ? h('div', { class: 'small' }, x.description) : null,
    h('div', { class: 'row small' }, x.sourceUrl ? ext(x.sourceUrl, 'Fonte ↗') : h('span', { class: 'muted' }, 'Sem fonte informada'), x.origin === 'usuario' ? h('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (confirm('Remover este item?')) { await api(`/deadlines/${x.id}`, { method: 'DELETE' }); viewAgenda(main); } } }, 'Remover') : null));
  fill(main, 
    h('h1', null, 'Agenda de eventos e prazos'),
    h('p', { class: 'lead' }, 'Prazos que você cadastra e movimentações recentes das proposições acompanhadas. O sistema não inventa datas: marcos legais só entram na agenda quando você os cadastra com a fonte oficial.'),
    state.static ? banner('info', 'Para cadastrar prazos, edite a lista "deadlines" no arquivo config/settings.json do repositório no GitHub (título, data AAAA-MM-DD e link oficial). Eles entram na próxima coleta e geram lembretes no celular.', ' ', ext(`${repoUrl()}/edit/main/config/settings.json`, 'Abrir o arquivo para editar ↗')) : form,
    h('h2', null, 'Próximos prazos'), h('div', { class: 'stack' }, d.upcoming.length ? d.upcoming.map(row) : [h('p', { class: 'muted' }, 'Nenhum prazo cadastrado.')]),
    h('h2', null, 'Movimentações legislativas recentes (últimos 45 dias)'),
    h('div', { class: 'stack' }, d.recentMoves.length ? d.recentMoves.map((m) => h('div', { class: 'card alert-row' }, h('strong', null, m.title), h('div', { class: 'small muted' }, `${fmtDT(m.ts)} · ${m.stage ? state.meta.stages.find((x) => x.id === m.stage)?.label : ''}`), h('div', { class: 'small' }, (m.descricao || m.situacao || '').slice(0, 300)), ext(m.official_url, 'Ficha oficial ↗', 'small'))) : [h('p', { class: 'muted' }, 'Sem movimentações recentes nas proposições acompanhadas.')]),
    d.past.length ? [h('h2', null, 'Prazos passados'), h('div', { class: 'stack' }, d.past.map(row))] : null);
}

// =============== Alertas ===============
async function viewAlertas(main) {
  let kind = '', unread = false;
  const list = h('div', { class: 'stack' });
  const load = async () => {
    const q = new URLSearchParams(Object.entries({ kind, unread: unread ? '1' : '' }).filter(([, v]) => v));
    try {
      const d = await api(`/alerts?${q}`);
      list.replaceChildren(...(d.alerts.length ? d.alerts.map((a) => h('article', { class: `card alert-row ${a.severity} ${a.read ? '' : 'unread'}` },
        h('div', { class: 'row' }, chip(KINDS[a.kind] || a.kind), a.isDemo ? demoChip() : null, h('span', { class: 'muted small grow' }, fmtDT(a.createdAt)),
          ...a.delivery.map((x) => chip(`${CH_LABEL[x.channel] || x.channel}:${{ sent: 'enviado', pending: 'na fila', failed: 'falhou', skipped: 'não enviado' }[x.status] || x.status}`, x.status === 'failed' ? 'bad' : '')),
          a.read ? null : h('button', { class: 'btn small', type: 'button', onclick: async () => { await api(`/alerts/${a.id}/read`, { method: 'POST', body: {} }); await refreshStatus(); load(); } }, 'Marcar como lido')),
        h('strong', null, a.title), a.body ? h('div', { class: 'body small' }, a.body) : null,
        a.link ? (a.link.startsWith('#') ? h('a', { href: a.link, class: 'small' }, 'Abrir no painel') : ext(a.link, 'Abrir fonte ↗', 'small')) : null)) : [h('p', { class: 'muted' }, 'Nenhum alerta ainda. Configure regras em Configurações.')]));
    } catch (e) { list.replaceChildren(errBox(e)); }
  };
  fill(main, 
    h('h1', null, 'Central de alertas'),
    h('p', { class: 'lead' }, 'Histórico de tudo o que o sistema detectou conforme suas regras. Alertas repetidos sobre o mesmo acontecimento são evitados; republicações de notícias não geram novo alerta.'),
    h('div', { class: 'filters' },
      h('label', { class: 'field' }, 'Tipo', h('select', { onchange: (e) => { kind = e.target.value; load(); } }, [['', 'Todos'], ...Object.entries(KINDS)].map(([v, l]) => h('option', { value: v }, l)))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { unread = e.target.checked; load(); } }), 'Só não lidos'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { await api('/alerts/read-all', { method: 'POST', body: {} }); await refreshStatus(); load(); } }, 'Marcar todos como lidos')),
    list);
  load();
}

// =============== Favoritos ===============
async function viewFavoritos(main) {
  const [favs, cur, news, legis] = await Promise.all([api('/favorites'), api('/currencies'), api('/news'), api('/legislation')]);
  const set = (k) => new Set(favs.filter((f) => f.kind === k).map((f) => f.ref));
  const fc = set('currency'), fn = set('news'), fl = set('legis');
  const cs = cur.currencies.filter((c) => c.active && fc.has(c.code)), ns = news.filter((n) => fn.has(String(n.id))), ls = legis.filter((l) => fl.has(l.id));
  fill(main, 
    h('h1', null, 'Favoritos'),
    !(cs.length + ns.length + ls.length) ? h('p', { class: 'lead' }, 'Marque com ☆ moedas, notícias e proposições para acompanhá-las aqui.') : null,
    cs.length ? [h('h2', null, 'Moedas'), h('div', { class: 'grid' }, cs.map((c) => fxCard(c, () => viewFavoritos(main))))] : null,
    ns.length ? [h('h2', null, 'Notícias'), h('div', { class: 'stack' }, ns.map(newsCard))] : null,
    ls.length ? [h('h2', null, 'Legislação'), h('div', { class: 'stack' }, ls.map(legisCard))] : null);
}

// =============== Configurações ===============
function ruleFormFields(type) {
  const M = state.meta;
  const field = (label, el) => h('label', { class: 'field' }, label, el);
  const code = h('select', null, M.currencies.map((c) => h('option', { value: c.code }, c.pair)));
  const rt = h('select', null, [['comercial', 'Comercial'], ['ptax', 'PTAX'], ['turismo', 'Turismo']].map(([v, l]) => h('option', { value: v }, l)));
  const val = h('input', { type: 'number', step: 'any', min: 0 });
  const pct = h('input', { type: 'number', step: '0.1', min: 0.1, value: 1 });
  const win = h('select', null, [[15, '15 minutos'], [60, '1 hora'], [240, '4 horas'], [1440, '24 horas']].map(([v, l]) => h('option', { value: v, selected: v === 60 }, l)));
  if (type === 'price_above' || type === 'price_below') return { nodes: [field('Moeda', code), field('Tipo de cotação', rt), field(type === 'price_above' ? 'Avisar quando ficar acima de (R$)' : 'Avisar quando ficar abaixo de (R$)', val)], get: () => ({ code: code.value, rate_type: rt.value, value: +val.value }) };
  if (type === 'pct_move') return { nodes: [field('Moeda', code), field('Tipo de cotação', rt), field('Variação mínima (%)', pct), field('Em uma janela de', win)], get: () => ({ code: code.value, rate_type: rt.value, pct: +pct.value, windowMin: +win.value }) };
  if (type === 'news') {
    const lvl = h('select', null, [['alta', 'Só relevância alta'], ['media', 'Média e alta']].map(([v, l]) => h('option', { value: v }, l)));
    const topics = M.topics.map((t) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: t.id }), t.label));
    return { nodes: [field('Relevância mínima', lvl), h('fieldset', null, h('legend', { class: 'small' }, 'Assuntos (nenhum marcado = todos)'), ...topics)], get: () => ({ minLevel: lvl.value, topics: topics.map((l) => l.firstChild).filter((i) => i.checked).map((i) => i.value) }) };
  }
  if (type === 'legis') {
    const mode = h('select', null, [['stage', 'Só mudança de etapa/situação'], ['any', 'Qualquer movimentação (pode ser muito frequente)']].map(([v, l]) => h('option', { value: v }, l)));
    return { nodes: [field('Avisar quando houver', mode)], get: () => ({ mode: mode.value, onlyCurated: true }) };
  }
  const days = h('input', { type: 'text', value: '7,3,1,0' });
  return { nodes: [field('Avisar quantos dias antes (separe por vírgula)', days)], get: () => ({ daysBefore: days.value.split(',').map((x) => +x.trim()).filter((x) => Number.isFinite(x)) }) };
}

function ruleSummary(r) {
  const p = r.params, c = state.meta.currencies.find((x) => x.code === p.code);
  switch (r.type) {
    case 'price_above': return `${c?.pair} (${p.rate_type}) acima de R$ ${fmtNum(p.value, 4)}`;
    case 'price_below': return `${c?.pair} (${p.rate_type}) abaixo de R$ ${fmtNum(p.value, 4)}`;
    case 'pct_move': return `${c?.pair} (${p.rate_type}) variar ±${p.pct}% em ${p.windowMin} min`;
    case 'news': return `Notícias de relevância ${p.minLevel === 'alta' ? 'alta' : 'média ou alta'}${p.topics?.length ? ` · ${p.topics.length} assunto(s)` : ''}`;
    case 'legis': return p.mode === 'any' ? 'Qualquer movimentação nas proposições acompanhadas' : 'Mudança de etapa/situação nas proposições acompanhadas';
    default: return `Prazos: ${p.daysBefore?.join(', ')} dia(s) antes`;
  }
}

/** URL do repositório, deduzida do endereço do GitHub Pages (usuario.github.io/repositorio). */
function repoUrl() {
  const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return m && repo ? `https://github.com/${m[1]}/${repo}` : 'https://github.com';
}

async function viewConfigStatic(main) {
  const [meta, cur, rules, prefs, status] = await Promise.all([Promise.resolve(state.meta), api('/currencies'), api('/rules'), api('/prefs'), api('/status')]);
  const edit = ext(`${repoUrl()}/edit/main/config/settings.json`, 'Editar config/settings.json no GitHub ↗');
  const d = prefs.delivery;
  main.replaceChildren(...[
    h('h1', null, 'Configurações'),
    banner('info', h('strong', null, 'Nesta versão as configurações ficam em um arquivo. '), 'Para mudar moedas, regras de alerta, horários ou prazos, edite o arquivo no GitHub e salve; a próxima coleta (até ~15 min) aplica. ', edit),
    h('div', { class: 'card stack' }, h('h3', null, 'Receber alertas no celular (ntfy)'),
      h('ol', { class: 'small' }, h('li', null, 'Instale o app gratuito ', h('strong', null, 'ntfy'), ' (Android: Google Play · iPhone: App Store).'), h('li', null, 'No app, toque em "+" e assine o tópico secreto que foi informado a você na configuração.'), h('li', null, 'Pronto: os alertas chegam como notificação, mesmo com este app fechado.')),
      chip(status.channels.ntfy ? 'ntfy configurado no servidor' : 'ntfy ainda NÃO configurado (falta o segredo NTFY_TOPIC no GitHub)', status.channels.ntfy ? 'ok' : 'warn')),
    h('div', { class: 'card stack' }, h('h3', null, 'Moedas acompanhadas'), h('div', { class: 'tags' }, ...cur.currencies.filter((c) => c.active).map((c) => chip(`${c.pair}`)))),
    h('div', { class: 'card stack' }, h('h3', null, 'Regras de alerta'), ...rules.rules.map((r) => h('div', { class: 'alert-row card' }, h('div', { class: 'row' }, h('strong', { class: 'grow' }, r.name), r.enabled ? chip('Ativa', 'ok') : chip('Desativada'), ...r.channels.map((c) => chip(CH_LABEL[c] || c))), h('div', { class: 'small muted' }, ruleSummary(r))))),
    h('div', { class: 'card stack' }, h('h3', null, 'Recebimento'),
      h('p', { class: 'small' }, `Notificações no celular entre ${d.startHour}h e ${d.endHour}h (Brasília)${d.weekdaysOnly ? ', só em dias úteis' : ''}, com intervalo mínimo de ${d.minIntervalMin} min; alertas acumulados saem juntos.`),
      h('p', { class: 'small' }, `Resumo diário: ${prefs.digest.daily.enabled ? `às ${prefs.digest.daily.hour}h` : 'desativado'} · Resumo semanal: ${prefs.digest.weekly.enabled ? `${WEEKDAYS[prefs.digest.weekly.weekday]}, ${prefs.digest.weekly.hour}h` : 'desativado'}`)),
    h('div', { class: 'card stack' }, h('h3', null, 'Estado das coletas'),
      h('p', { class: 'small muted' }, `Última geração dos dados: ${fmtDT(status.generatedAt)} (${ago(status.generatedAt)}). O GitHub executa a coleta de ~15 em ~15 min, com atrasos possíveis.`),
      h('table', { class: 't' }, h('thead', null, h('tr', null, ['Tarefa', 'Última coleta ok', 'Situação'].map((x) => h('th', null, x)))),
        h('tbody', null, status.jobs.map((j) => h('tr', null, h('td', null, j.label), h('td', null, j.lastOkAt ? `${fmtDT(j.lastOkAt)} (${ago(j.lastOkAt)})` : 'nunca'), h('td', null, j.consecutiveFailures ? chip(`${j.consecutiveFailures} falha(s): ${(j.lastError || '').slice(0, 90)}`, 'bad') : j.stale ? chip('desatualizada', 'warn') : chip('ok', 'ok'))))))),
    h('h2', null, 'Ajuda'),
    h('div', { class: 'card stack' }, h('h3', null, 'Glossário'), h('dl', { class: 'meta' }, Object.entries(meta.glossary).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))),
  ]);
}

async function viewConfig(main) {
  if (state.static) return viewConfigStatic(main);
  const [meta, cur, rules, prefs, status] = await Promise.all([Promise.resolve(state.meta), api('/currencies'), api('/rules'), api('/prefs'), api('/status')]);
  state.prefs = prefs; state.status = status; renderNotices();
  const av = status.channels;

  // Moedas
  const curBox = h('div', { class: 'card stack' }, h('h3', null, 'Moedas acompanhadas'),
    h('p', { class: 'muted small' }, 'Marque para ativar. Moedas novas passam a ser coletadas na próxima rodada e o histórico é carregado automaticamente.'),
    h('div', { class: 'grid' }, cur.currencies.map((c) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.active, onchange: async (e) => { try { await api(`/currencies/${c.code}/active`, { method: 'POST', body: { active: e.target.checked } }); } catch (err) { alert(err.message); e.target.checked = !e.target.checked; } } }), `${c.pair} — ${c.name}`, !c.hasPtax ? h('span', { class: 'muted small' }, ' (sem PTAX)') : null))));

  // Regras
  let ruleType = 'price_above', ff = ruleFormFields(ruleType);
  const ffBox = h('div', { class: 'filters' }, ...ff.nodes);
  const name = h('input', { type: 'text', maxlength: 120, placeholder: 'Nome (opcional)' });
  const chEmail = h('input', { type: 'checkbox' }), chTg = h('input', { type: 'checkbox' }), chNt = h('input', { type: 'checkbox' });
  const cool = h('input', { type: 'number', min: 0, max: 1440, value: 60 });
  const typeSel = h('select', { onchange: (e) => { ruleType = e.target.value; ff = ruleFormFields(ruleType); ffBox.replaceChildren(...ff.nodes); } }, Object.entries(meta.ruleTypes).map(([v, l]) => h('option', { value: v }, l)));
  const rulesList = h('div', { class: 'stack' }, rules.rules.map((r) => h('div', { class: 'card alert-row' },
    h('div', { class: 'row' }, h('strong', { class: 'grow' }, r.name), chip(meta.ruleTypes[r.type]), ...r.channels.map((c) => chip(CH_LABEL[c] || c))),
    h('div', { class: 'small muted' }, ruleSummary(r)),
    h('div', { class: 'row' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.enabled, onchange: async (e) => { await api(`/rules/${r.id}`, { method: 'PUT', body: { enabled: e.target.checked } }); } }), 'Ativa'),
      h('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (confirm('Remover esta regra?')) { await api(`/rules/${r.id}`, { method: 'DELETE' }); viewConfig(main); } } }, 'Remover')))));
  const ruleForm = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault();
    const channels = ['inapp', ...(chEmail.checked ? ['email'] : []), ...(chTg.checked ? ['telegram'] : []), ...(chNt.checked ? ['ntfy'] : [])];
    try { await api('/rules', { method: 'POST', body: { type: ruleType, name: name.value, params: ff.get(), channels, cooldown_min: +cool.value } }); viewConfig(main); } catch (err) { alert(err.message); }
  } },
    h('h3', null, 'Nova regra de alerta'),
    h('label', { class: 'field' }, 'Tipo de alerta', typeSel), ffBox, h('div', { class: 'filters' }, h('label', { class: 'field' }, 'Nome', name), h('label', { class: 'field' }, 'Intervalo mínimo entre disparos (min)', cool)),
    h('div', { class: 'row' }, h('span', { class: 'small' }, 'Enviar também por:'),
      h('label', { class: 'check' }, chEmail, 'E-mail'), h('label', { class: 'check' }, chTg, 'Telegram'), h('label', { class: 'check' }, chNt, 'Celular (ntfy)')),
    h('button', { class: 'btn primary', type: 'submit' }, 'Adicionar regra'));

  // Entrega e canais
  const d = prefs.delivery, E = prefs.channels.email, T = prefs.channels.telegram, DD = prefs.digest.daily, WW = prefs.digest.weekly;
  const num = (v, a, b) => h('input', { type: 'number', min: a, max: b, value: v });
  const startH = num(d.startHour, 0, 23), endH = num(d.endHour, 0, 24), minInt = num(d.minIntervalMin, 0, 1440);
  const wk = h('input', { type: 'checkbox', checked: d.weekdaysOnly });
  const ntEn = h('input', { type: 'checkbox', checked: prefs.channels.ntfy?.enabled });
  const emEn = h('input', { type: 'checkbox', checked: E.enabled }), emTo = h('input', { type: 'email', value: E.to, placeholder: 'voce@empresa.com.br' });
  const tgEn = h('input', { type: 'checkbox', checked: T.enabled }), tgId = h('input', { type: 'text', value: T.chatId, placeholder: 'ex.: 123456789' });
  const dEn = h('input', { type: 'checkbox', checked: DD.enabled }), dHr = num(DD.hour, 0, 23);
  const wEn = h('input', { type: 'checkbox', checked: WW.enabled }), wHr = num(WW.hour, 0, 23);
  const wDay = h('select', null, WEEKDAYS.map((n, i) => h('option', { value: i, selected: i === WW.weekday }, n)));
  const dEm = h('input', { type: 'checkbox', checked: DD.channels.includes('email') }), dTg = h('input', { type: 'checkbox', checked: DD.channels.includes('telegram') });
  const wEm = h('input', { type: 'checkbox', checked: WW.channels.includes('email') }), wTg = h('input', { type: 'checkbox', checked: WW.channels.includes('telegram') });
  const regime = h('select', null, [['', 'Não informado'], ...meta.regimes.map((r) => [r, r])].map(([v, l]) => h('option', { value: v, selected: prefs.profile.regime === v }, l)));
  const setor = h('select', null, [['', 'Não informado'], ...SETORES.map((r) => [r, r])].map(([v, l]) => h('option', { value: v, selected: prefs.profile.setor === v }, l)));
  const uf = h('select', null, [['', 'Não informado'], ...meta.ufs.map((r) => [r, r])].map(([v, l]) => h('option', { value: v, selected: prefs.profile.uf === v }, l)));
  const msg = h('span', { class: 'small', role: 'status' });
  const chans = (a, b) => [...['inapp'], ...(a.checked ? ['email'] : []), ...(b.checked ? ['telegram'] : [])];
  const test = (ch) => h('button', { class: 'btn small', type: 'button', disabled: !av[ch], title: av[ch] ? '' : 'Credenciais não configuradas no servidor', onclick: async () => { msg.textContent = 'Enviando teste…'; try { await api('/channels/test', { method: 'POST', body: { channel: ch } }); msg.textContent = 'Teste enviado. Verifique sua caixa.'; } catch (e) { msg.textContent = e.message; } } }, 'Enviar teste');
  const tgFind = h('button', { class: 'btn small', type: 'button', disabled: !av.telegram, onclick: async () => { msg.textContent = 'Procurando…'; try { const r = await api('/telegram/chats'); msg.textContent = r.chats.length ? `Chats encontrados: ${r.chats.map((c) => `${c.id} (${c.nome})`).join('; ')}` : r.dica; if (r.chats[0]) tgId.value = r.chats[0].id; } catch (e) { msg.textContent = e.message; } } }, 'Descobrir meu Chat ID');
  const save = async () => {
    try {
      state.prefs = await api('/prefs', { method: 'PUT', body: {
        delivery: { startHour: +startH.value, endHour: +endH.value, weekdaysOnly: wk.checked, minIntervalMin: +minInt.value },
        channels: { email: { enabled: emEn.checked, to: emTo.value }, telegram: { enabled: tgEn.checked, chatId: tgId.value }, ntfy: { enabled: ntEn.checked } },
        digest: { daily: { enabled: dEn.checked, hour: +dHr.value, channels: chans(dEm, dTg) }, weekly: { enabled: wEn.checked, hour: +wHr.value, weekday: +wDay.value, channels: chans(wEm, wTg) } },
        profile: { regime: regime.value, setor: setor.value, uf: uf.value },
      } });
      state.legis = null; msg.textContent = 'Configurações salvas.';
    } catch (e) { msg.textContent = e.message; }
  };
  const cfg = (...kids) => h('div', { class: 'card stack' }, ...kids);
  const f = (l, el) => h('label', { class: 'field' }, l, el);
  const delivery = cfg(h('h3', null, 'Recebimento e canais externos'),
    banner('info', 'Os alertas sempre aparecem no painel. E-mail e Telegram só funcionam se o servidor tiver as credenciais configuradas (variáveis de ambiente). Envios fora do horário ficam na fila até a janela abrir; alertas comuns acumulados saem juntos em uma mensagem, respeitando o intervalo mínimo.'),
    h('div', { class: 'filters' }, f('Receber a partir de (hora)', startH), f('Receber até (hora)', endH), f('Intervalo mínimo entre mensagens (min)', minInt), h('label', { class: 'check' }, wk, 'Só em dias úteis')),
    h('div', { class: 'filters' }, h('label', { class: 'check' }, emEn, 'E-mail'), f('Enviar para', emTo), chip(av.email ? 'SMTP configurado no servidor' : 'SMTP NÃO configurado', av.email ? 'ok' : 'warn'), test('email')),
    h('div', { class: 'filters' }, h('label', { class: 'check' }, ntEn, 'Celular (ntfy)'), chip(av.ntfy ? 'NTFY_TOPIC configurado' : 'NTFY_TOPIC NÃO configurado', av.ntfy ? 'ok' : 'warn'), test('ntfy')),
    h('div', { class: 'filters' }, h('label', { class: 'check' }, tgEn, 'Telegram'), f('Chat ID', tgId), chip(av.telegram ? 'Bot configurado no servidor' : 'Bot NÃO configurado', av.telegram ? 'ok' : 'warn'), test('telegram'), tgFind),
    h('h3', null, 'Resumos'),
    h('div', { class: 'filters' }, h('label', { class: 'check' }, dEn, 'Resumo diário'), f('às (hora)', dHr), h('label', { class: 'check' }, dEm, 'e-mail'), h('label', { class: 'check' }, dTg, 'Telegram')),
    h('div', { class: 'filters' }, h('label', { class: 'check' }, wEn, 'Resumo semanal'), f('dia', wDay), f('às (hora)', wHr), h('label', { class: 'check' }, wEm, 'e-mail'), h('label', { class: 'check' }, wTg, 'Telegram')),
    h('h3', null, 'Perfil da empresa (filtro padrão da legislação)'),
    h('div', { class: 'filters' }, f('Regime tributário', regime), f('Setor', setor), f('Estado (UF)', uf)),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Salvar'), msg),
    h('p', { class: 'muted small' }, 'Horários no fuso America/Sao_Paulo (Brasília).'));

  // Fontes
  const src = h('div', { class: 'card stack' }, h('h3', null, 'Estado das coletas'),
    h('table', { class: 't' }, h('thead', null, h('tr', null, ['Tarefa', 'Frequência', 'Última coleta ok', 'Situação'].map((x) => h('th', null, x)))),
      h('tbody', null, status.jobs.map((j) => h('tr', null, h('td', null, j.label), h('td', null, `a cada ${j.everyMin >= 1440 ? '24 h' : j.everyMin + ' min'}`), h('td', null, j.lastOkAt ? `${fmtDT(j.lastOkAt)} (${ago(j.lastOkAt)})` : 'nunca'), h('td', null, j.consecutiveFailures ? chip(`${j.consecutiveFailures} falha(s): ${(j.lastError || '').slice(0, 90)}`, 'bad') : j.stale ? chip('desatualizada', 'warn') : chip('ok', 'ok')))))));

  // Glossário
  const gloss = h('div', { class: 'card stack' }, h('h3', null, 'Glossário'), h('dl', { class: 'meta' }, Object.entries(meta.glossary).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));

  fill(main, h('h1', null, 'Configurações'), curBox, h('h2', null, 'Regras de alerta'), rulesList, ruleForm, h('h2', null, 'Entrega'), delivery, h('h2', null, 'Fontes'), src, h('h2', null, 'Ajuda'), gloss);
}

// =============== Simulador de remessa ===============
const OPS_KEY = 'monitor.ops';
const loadOps = () => { try { return JSON.parse(localStorage.getItem(OPS_KEY)) || []; } catch { return []; } };
const saveOps = (ops) => { try { localStorage.setItem(OPS_KEY, JSON.stringify(ops)); } catch { /* sem armazenamento: não persiste */ } };
const brl = (v) => `R$ ${fmtNum(v, 2)}`;

async function viewSimulador(main) {
  const cur = await api('/currencies');
  const active = cur.currencies.filter((c) => c.active);
  const num = (v, extra) => h('input', { type: 'number', step: 'any', min: 0, value: v, ...extra });
  const field = (label, el, help) => h('label', { class: 'field' }, label, el, help ? h('span', { class: 'muted small' }, help) : null);

  const modo = h('select', null, [['pagamento', 'Pagamento ao exterior (envio)'], ['recebimento', 'Recebimento de exportação']].map(([v, l]) => h('option', { value: v }, l)));
  const preset = h('select', null, [['', 'Personalizado'], ...PRESETS.map((p) => [p.id, p.nome])].map(([v, l]) => h('option', { value: v }, l)));
  const moeda = h('select', null, active.map((c) => h('option', { value: c.code }, `${c.code} — ${c.name}`)));
  const paisSel = h('select', null, [['', 'Selecione o país'], ...PAISES_LISTA.map((p) => [p, p])].map(([v, l]) => h('option', { value: v }, l)));
  const natSel = h('select', null, [['', 'Selecione a natureza'], ...Object.entries(NATUREZAS).map(([k, n]) => [k, n.label])].map(([v, l]) => h('option', { value: v }, l)));
  const sugestao = h('div', { class: 'small stack' });
  // Regra do usuário: na conferência da cotação de envio só entram IRRF e IOF; CIDE/PIS/Cofins só se ele pedir.
  const incluirOutros = h('input', { type: 'checkbox', checked: false });
  const cideIn = num(OUTROS.cide.pct), pisIn = num(OUTROS.pis.pct), cofinsIn = num(OUTROS.cofins.pct), issIn = num(OUTROS.iss.pct);
  const fonte = h('select', null);
  const valor = num(1000), taxa = num(''), spread = num(0, { min: -50 }), tarifa = num(0), tarifaME = num(0), qtdServ = num(1, { min: 1 });
  const feeBrl = (rate) => (+tarifa.value || 0) + (+tarifaME.value || 0) * (Math.max(1, Math.round(+qtdServ.value) || 1)) * rate;
  const hojeSP = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const dataCambio = h('input', { type: 'date', value: hojeSP });
  const ptaxNote = h('span', { class: 'muted small' });
  let ptaxHist = [];
  const ptaxOn = () => { let best = null; for (const p of ptaxHist) if (p.t <= dataCambio.value) best = p; return best; };
  const loadPtax = async () => { try { ptaxHist = (await api('/currencies/' + moeda.value + '/history?type=ptax&range=365d')).points; } catch { ptaxHist = []; } compute(); };
  const iofPct = num(3.5), irPct = num(0), gross = h('input', { type: 'checkbox', checked: true });
  const nota = h('p', { class: 'small muted' });
  const out = h('div', { class: 'card stack', 'aria-live': 'polite' });

  const typesOf = () => (active.find((c) => c.code === moeda.value)?.types || []).filter((t) => t.available);
  const refreshFonte = () => {
    const opts = [...typesOf().map((t) => [t.type, `${t.short}: R$ ${fmtNum(t.value, 4)}`]), ['manual', 'Informar a taxa do banco']];
    fonte.replaceChildren(...opts.map(([v, l]) => h('option', { value: v, selected: v === (typesOf().some((t) => t.type === 'ptax') ? 'ptax' : 'manual') }, l)));
  };
  const baseRate = () => {
    if (fonte.value === 'manual') return +taxa.value || 0;
    const t = typesOf().find((x) => x.type === fonte.value);
    if (!t) return 0;
    let v = t.value;
    ptaxNote.textContent = '';
    if (t.type === 'ptax') {
      const pp = ptaxOn();
      if (pp) { v = pp.v; ptaxNote.textContent = 'PTAX de ' + fmtDay(pp.t); }
      else if (dataCambio.value && dataCambio.value < hojeSP) ptaxNote.textContent = 'Sem PTAX histórica para esta data: usando a mais recente.';
    } else if (dataCambio.value && dataCambio.value < hojeSP) ptaxNote.textContent = 'Só a PTAX tem histórico por data: usando a taxa atual.';
    return v * (1 + (+spread.value || 0) / 100);
  };
  const decimals = () => active.find((c) => c.code === moeda.value)?.decimals ?? 4;

  const row = (k, v, strong) => h('tr', null, h('td', null, k), h('td', { class: strong ? 'delta' : '' }, v));
  const compute = () => {
    const amount = +valor.value, rate = baseRate();
    if (!(amount > 0) || !(rate > 0)) { out.replaceChildren(h('p', { class: 'muted' }, 'Informe o valor e a taxa para ver o custo.')); return null; }
    let res;
    if (modo.value === 'recebimento') {
      const r = simulateReceipt({ amount, rate, fee: feeBrl(rate), iofPct: +iofPct.value || 0 });
      res = r;
      out.replaceChildren(h('h3', null, 'Quanto você recebe'), h('table', { class: 't' }, h('tbody', null,
        row('Taxa aplicada', `R$ ${fmtNum(rate, decimals())}`), row('Valor bruto em reais', brl(r.reais)), row('IOF', brl(r.iof)), row('Tarifa', brl(r.fee)),
        row('Você recebe (líquido)', brl(r.liquido), true), row('Taxa efetiva por unidade', `R$ ${fmtNum(r.taxaEfetiva, 4)}`))),
      h('p', { class: 'muted small' }, 'Exportação: IOF zero para receitas de exportação (Decreto 6.306, art. 15-B, I). Spread do banco entra na taxa informada.'));
    } else {
      const r = simulate({ amount, rate, iofPct: +iofPct.value || 0, irPct: +irPct.value || 0, grossUp: gross.checked, fee: feeBrl(rate) });
      res = r;
      out.replaceChildren(h('h3', null, 'Quanto custa'), h('table', { class: 't' }, h('tbody', null,
        row('Taxa aplicada', `R$ ${fmtNum(rate, decimals())}`), row('Valor em reais (valor × taxa)', brl(r.reais)), row(`IOF (${fmtNum(+iofPct.value || 0, 2)}%)`, brl(r.iof)),
        row(`IR (${fmtNum(+irPct.value || 0, 2)}%${gross.checked && +irPct.value > 0 ? ', gross-up' : ''})${gross.checked && +irPct.value > 0 ? ` sobre base ${brl(r.irBase)}` : ''}`, brl(r.ir)),
        row('Tarifa', brl(r.fee)), row('Custo total em reais', brl(r.total), true),
        row('VET sem IR (como o banco costuma imprimir)', `R$ ${fmtNum(r.vetSemIr, 5)}`), row('VET com IR (custo real por unidade)', `R$ ${fmtNum(r.vetComIr, 4)}`),
        row('Quanto acima da taxa de câmbio', `${fmtNum(r.acimaDaTaxaPct, 2)}%`))),
      h('p', { class: 'muted small' }, 'Estimativa. IOF e IR dependem da finalidade, do país e do tratado: confirme com o contador e o banco.'));
      out.append(outrosNode(r));
    }
    return { res, amount, rate };
  };

  /** Tributos que a empresa apura fora da cotação do banco (CIDE, PIS/Cofins-importação, ISS). */
  const outrosNode = (r) => {
    if (!incluirOutros.checked) return h('span');
    if (!natSel.value) return h('p', { class: 'muted small' }, 'Escolha a natureza do pagamento para estimar CIDE, PIS/Cofins-importação e ISS: tributos que a sua empresa recolhe, fora da cotação do banco.');
    const o = calcOutros({ reais: r.reais, natureza: natSel.value, cide: +cideIn.value || 0, pis: +pisIn.value || 0, cofins: +cofinsIn.value || 0, iss: +issIn.value || 0 });
    if (!o.itens.length) return h('p', { class: 'muted small' }, 'Para esta natureza não estimo CIDE, PIS/Cofins-importação nem ISS.');
    const totalGeral = Math.round((r.total + o.total) * 100) / 100;
    return h('div', { class: 'stack' },
      h('h3', null, 'Tributos que a empresa recolhe, fora da cotação do banco (estimativa)'),
      h('p', { class: 'small muted' }, 'A cotação do banco traz só câmbio, IOF, IR e tarifa: ela NÃO inclui ISS, CIDE nem PIS/Cofins. Esses valores são apurados e pagos pela empresa. Para tirar algum do cálculo, zere a alíquota no campo correspondente.'),
      h('table', { class: 't' }, h('tbody', null,
        ...o.itens.map((i) => h('tr', null, h('td', null, `${i.label} (${fmtNum(i.pct, 2)}%) `, chip(STATUS[i.status].label, STATUS[i.status].cls)), h('td', null, brl(i.valor)))),
        row('Total desses tributos', brl(o.total)),
        row('Custo total com tudo (banco + empresa)', brl(totalGeral), true),
        row('Custo por unidade de moeda estrangeira', `R$ ${fmtNum(totalGeral / (+valor.value || 1), 4)}`),
        o.creditavel > 0 ? row('Se PIS/Cofins virarem crédito (Lucro Real)', brl(totalGeral - o.creditavel)) : null)),
      h('p', { class: 'muted small' }, 'Cálculo simplificado sobre o valor em reais: na importação de serviço a base de PIS/Cofins inclui o ISS e as próprias contribuições, e há discussão judicial sobre isso. A alíquota do ISS é do seu município (2% a 5%). Confirme tudo com o contador.'));
  };
  const applySugestao = () => {
    const s = sugerirIR(paisSel.value, natSel.value);
    if (!s) { sugestao.replaceChildren(h('span', { class: 'muted' }, 'Escolha o país e a natureza do pagamento para sugerir o IR.')); compute(); return; }
    irPct.value = s.ir; gross.checked = s.ir > 0;
    preset.value = '';
    fill(sugestao,
      h('div', null, chip(STATUS[s.status].label, STATUS[s.status].cls), ` IR sugerido: ${fmtNum(s.ir, 2)}%`, s.irMin != null && s.irMin !== s.ir ? ` (pode cair para ${fmtNum(s.irMin, 2)}% se o tratado ou a condição se aplicar; para orçar, use o maior)` : ''),
      h('div', { class: 'muted' }, s.nota),
      h('div', { class: 'muted' }, 'Tratado: ', s.tratado),
      s.fontes.length ? h('div', null, 'Fontes: ', ...s.fontes.flatMap((id, i) => [i ? ' · ' : '', ext(FONTES[id][1], FONTES[id][0])])) : null);
    compute();
  };
  const applyPreset = () => {
    const p = PRESETS.find((x) => x.id === preset.value);
    if (!p) { nota.textContent = ''; return; }
    modo.value = p.modo; iofPct.value = p.iofPct; irPct.value = p.irPct; gross.checked = p.grossUp;
    nota.replaceChildren(chip(p.status === 'a confirmar' ? 'A CONFIRMAR' : p.status === 'observado' ? 'Observado em operação real' : 'Confirmado no texto oficial', p.status === 'a confirmar' ? 'warn' : 'ok'), ' ', p.nota);
    compute();
  };
  for (const el of [modo, fonte, valor, taxa, spread, tarifa, tarifaME, qtdServ, iofPct, irPct, gross, dataCambio]) el.addEventListener('input', compute);
  moeda.addEventListener('input', () => { refreshFonte(); loadPtax(); });
  preset.addEventListener('input', () => { paisSel.value = ''; natSel.value = ''; sugestao.replaceChildren(); applyPreset(); });
  for (const el of [paisSel, natSel]) el.addEventListener('input', applySugestao);
  for (const el of [incluirOutros, cideIn, pisIn, cofinsIn, issIn]) el.addEventListener('input', compute);
  refreshFonte();
  loadPtax();

  // ----- Ler invoice (PDF ou texto; nada sai do aparelho) -----
  const invFile = h('input', { type: 'file', accept: '.pdf,.txt,application/pdf,text/plain,image/*' });
  const invText = h('textarea', { rows: 5, placeholder: 'ou cole aqui o texto da invoice' });
  const invOut = h('div', { class: 'stack', 'aria-live': 'polite' });
  const NAT = { servico: 'Serviço', viagem: 'Viagem / hospedagem', mercadoria: 'Mercadoria', misto: 'Misto', outro: 'Outro' };
  const usar = (valorUsar, nat, r) => {
    if (active.some((c) => c.code === r.moeda)) { moeda.value = r.moeda; refreshFonte(); loadPtax(); }
    modo.value = 'pagamento'; valor.value = valorUsar; pais.value = r.pais || ''; fin.value = NAT[nat] || '';
    paisSel.value = PAISES_LISTA.includes(r.pais) ? r.pais : (r.pais ? 'Outro país' : '');
    natSel.value = { servico: 'tecnico', viagem: 'viagem', mercadoria: 'mercadoria' }[nat] || '';
    applySugestao(); out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const showInvoice = (r) => {
    const linhas = [['País do fornecedor', r.pais ? r.pais + ' (' + r.paisFonte + ')' : 'não identificado'], ['Valor', r.valor != null ? (r.moeda || '?') + ' ' + fmtNum(r.valor, 2) : 'não encontrado'], ['Número', r.numero || '—'], ['Data da invoice', r.data ? fmtDay(r.data) : '—'], ['Natureza', NAT[r.natureza] || '—']];
    const grupos = Object.entries(r.valorPorNatureza);
    invOut.replaceChildren(...[
      h('table', { class: 't' }, h('tbody', null, linhas.map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v))))),
      r.itens.length ? h('table', { class: 't' }, h('thead', null, h('tr', null, ['Item', 'Natureza sugerida', 'Valor'].map((x) => h('th', null, x)))), h('tbody', null, r.itens.map((i) => h('tr', null, h('td', null, i.descricao), h('td', null, NAT[i.natureza]), h('td', null, (r.moeda || '') + ' ' + fmtNum(i.valor, 2)))))) : null,
      ...r.avisos.map((a) => banner('warn', a)),
      banner('info', 'Leitura automática: confira os campos acima antes de decidir. A natureza do pagamento muda o IR e outros tributos.'),
      r.data && r.data < hojeSP ? banner('info', 'A invoice é de ' + fmtDay(r.data) + '. A data do câmbio muda a taxa: ajuste "Data do câmbio" no simulador para o dia do pagamento.') : null,
      h('div', { class: 'row' },
        ...grupos.map(([nat, v]) => h('button', { class: 'btn', type: 'button', onclick: () => usar(v, nat, r) }, 'Simular ' + (r.moeda || '') + ' ' + fmtNum(v, 2) + ' (' + NAT[nat] + ')')),
        r.valor != null && grupos.length !== 1 ? h('button', { class: 'btn primary', type: 'button', onclick: () => usar(r.valor, grupos.length ? 'misto' : r.natureza, r) }, 'Simular ' + (grupos.length ? 'o total ' : '') + (r.moeda || '') + ' ' + fmtNum(r.valor, 2)) : null),
    ].filter(Boolean));
  };
  invFile.addEventListener('change', async () => {
    const f = invFile.files[0];
    if (!f) return;
    invOut.replaceChildren(h('p', { class: 'muted' }, 'Lendo o arquivo…'));
    try {
      if (f.type.startsWith('image/')) { invOut.replaceChildren(banner('warn', 'Fotos e PDFs escaneados ainda não são lidos automaticamente (precisam de OCR). Cole o texto da invoice ao lado ou anexe o PDF original com texto.')); return; }
      const text = /pdf/i.test(f.type) || /\.pdf$/i.test(f.name) ? await readPdf(f) : await f.text();
      invText.value = text;
      if (!text.trim()) { invOut.replaceChildren(banner('warn', 'O PDF não tem texto selecionável (provavelmente é escaneado). Cole o texto manualmente.')); return; }
      showInvoice(parseInvoice(text));
    } catch (e) { invOut.replaceChildren(banner('bad', 'Não consegui ler o arquivo: ' + e.message)); }
  });

  // ----- Conferência de confirmação de câmbio -----
  const cAmount = num(''), cRate = num(''), cReais = num(''), cIof = num(''), cIr = num('');
  const cIofPct = num(3.5), cIrPct = num(8), cGross = h('input', { type: 'checkbox', checked: true });
  const cOut = h('div', { class: 'stack', 'aria-live': 'polite' });
  const check = () => {
    const amount = +cAmount.value, rate = +cRate.value;
    if (!(amount > 0) || !(rate > 0)) { cOut.replaceChildren(h('p', { class: 'muted' }, 'Informe o valor em moeda estrangeira e a taxa da confirmação.')); return; }
    const c = checkConfirmation({ amount, rate, reais: cReais.value === '' ? NaN : +cReais.value, iof: +cIof.value || 0, ir: +cIr.value || 0, iofPct: +cIofPct.value || 0, irPct: +cIrPct.value || 0, grossUp: cGross.checked });
    cOut.replaceChildren(...c.achados.map((a) => banner(a.nivel === 'erro' ? 'bad' : a.nivel === 'aviso' ? 'warn' : 'info', a.texto)),
      h('p', { class: 'small muted' }, `Esperado: valor em reais ${brl(c.esperado.reais)} · IOF ${brl(c.esperado.iof)} · IR ${brl(c.esperado.ir)} · total ${brl(c.esperado.total)}.`));
  };
  for (const el of [cAmount, cRate, cReais, cIof, cIr, cIofPct, cIrPct, cGross]) el.addEventListener('input', check);
  check();

  // ----- Minhas operações (ficam só neste aparelho) -----
  const opsBox = h('div', { class: 'stack' });
  const paintOps = () => {
    const ops = loadOps();
    opsBox.replaceChildren(ops.length ? h('table', { class: 't' }, h('thead', null, h('tr', null, ['Data', 'País / finalidade', 'IOF', 'IR', 'Taxa vs PTAX', ''].map((x) => h('th', null, x)))),
      h('tbody', null, ops.map((o, i) => h('tr', null, h('td', null, o.data), h('td', null, `${o.pais || '—'} · ${o.finalidade || '—'}`), h('td', null, `${fmtNum(o.iofPct, 2)}%`), h('td', null, `${fmtNum(o.irPct, 2)}%${o.grossUp && o.irPct ? ' (gross-up)' : ''}`),
        h('td', null, o.spreadVsPtax == null ? '—' : `${fmtPct(o.spreadVsPtax)}`), h('td', null, h('button', { class: 'btn small danger', type: 'button', onclick: () => { saveOps(loadOps().filter((_, j) => j !== i)); paintOps(); } }, 'Remover')))))) : h('p', { class: 'muted' }, 'Nenhuma operação registrada ainda.'));
  };
  const pais = h('input', { type: 'text', maxlength: 40, placeholder: 'ex.: Panamá' }), fin = h('input', { type: 'text', maxlength: 80, placeholder: 'ex.: serviço de software' });
  const salvar = h('button', { class: 'btn', type: 'button', onclick: () => {
    const ptax = typesOf().find((t) => t.type === 'ptax');
    const r = baseRate();
    saveOps([{ data: new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }), pais: pais.value.trim(), finalidade: fin.value.trim(), iofPct: +iofPct.value || 0, irPct: +irPct.value || 0, grossUp: gross.checked, spreadVsPtax: ptax && r ? ((r / ptax.value - 1) * 100) : null }, ...loadOps()].slice(0, 200));
    paintOps();
  } }, 'Salvar estas alíquotas em "Minhas operações"');
  paintOps();

  fill(main,
    h('h1', null, 'Simulador de remessa'),
    h('p', { class: 'lead' }, 'Estime rapidamente quanto custa pagar ou receber do exterior, antes de a resposta do banco chegar. As alíquotas são parâmetros que você controla: as predefinições indicam quais foram vistas em operação real, quais estão no texto oficial e quais ainda estão ', h('strong', null, 'a confirmar'), '.'),
    h('div', { class: 'card stack' }, h('h3', null, 'Ler uma invoice'),
      h('p', { class: 'small muted' }, 'Anexe o PDF (com texto) ou cole o texto. O app sugere valor, moeda, país e natureza, e você confere antes de simular. O arquivo é lido neste aparelho e não é enviado nem salvo.'),
      h('div', { class: 'filters' }, field('Arquivo', invFile), field('Texto da invoice', invText), h('button', { class: 'btn primary', type: 'button', onclick: () => showInvoice(parseInvoice(invText.value)) }, 'Ler texto colado')), invOut),
    h('div', { class: 'card stack' },
      h('div', { class: 'filters' }, field('Tipo de operação', modo), field('Predefinição', preset)), nota,
      h('div', { class: 'filters' }, field('País do fornecedor', paisSel), field('Natureza do pagamento', natSel)), sugestao,
      h('div', { class: 'filters' }, h('label', { class: 'check' }, incluirOutros, 'Estimar também CIDE/PIS/Cofins (opcional; a conferência padrão é só IRRF + IOF)'), field('CIDE (%)', cideIn, '0 = não incluir'), field('PIS-imp. (%)', pisIn, '0 = não incluir'), field('Cofins-imp. (%)', cofinsIn, '0 = não incluir'), field('ISS do município (%)', issIn, 'Não se aplica ao seu caso (0)')),
      h('div', { class: 'filters' }, field('Moeda', moeda), field('Taxa de referência', fonte), field('Spread do banco sobre a referência (%)', spread, 'Só vale para PTAX/comercial/turismo'), field('Taxa do banco (se informar)', taxa), field('Data do câmbio', dataCambio, 'Define a PTAX usada'), ptaxNote),
      h('div', { class: 'filters' }, field('Valor em moeda estrangeira', valor), field('IOF (%)', iofPct), field('IR (%)', irPct), field('Tarifas (R$)', tarifa), field('Tarifa por serviço (na moeda, ex.: 30)', tarifaME, 'Convertida pela taxa e somada ao total'), field('Nº de serviços', qtdServ), h('label', { class: 'check' }, gross, 'IR por conta do devedor (gross-up)'))),
    out,
    h('div', { class: 'card stack' }, h('h3', null, 'Guardar o que o banco cobrou'), h('p', { class: 'small muted' }, 'Registra só percentuais, país e finalidade neste aparelho (não vai para o GitHub). Serve de tabela de consulta para as próximas cotações.'),
      h('div', { class: 'filters' }, field('País', pais), field('Finalidade / natureza', fin), salvar)),
    h('h2', null, 'Conferir uma confirmação de câmbio'),
    h('div', { class: 'card stack' }, h('p', { class: 'small muted' }, 'Digite os valores impressos pelo banco. O app confere IOF e IR e avisa se faltar imposto, como no caso do IR que não foi retido.'),
      h('div', { class: 'filters' }, field('Valor em moeda estrangeira', cAmount), field('Taxa de câmbio', cRate), field('Valor em reais', cReais), field('IOF cobrado (R$)', cIof), field('IR cobrado (R$)', cIr)),
      h('div', { class: 'filters' }, field('IOF esperado (%)', cIofPct), field('IR esperado (%)', cIrPct), h('label', { class: 'check' }, cGross, 'IR com gross-up')), cOut),
    h('h2', null, 'Minhas operações'), h('div', { class: 'card' }, opsBox));
  compute();
}

// =============== Tributos por país (referência) ===============
function viewTributos(main) {
  const chipS = (st) => chip(STATUS[st].label, STATUS[st].cls);
  const fontesNodes = (ids) => (ids || []).flatMap((id, i) => (FONTES[id] ? [i ? ' · ' : '', ext(FONTES[id][1], FONTES[id][0])] : []));
  const nats = Object.entries(NATUREZAS);
  const tabela = h('div', { class: 'card' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, h('th', null, 'IRRF na remessa'), ...nats.map(([, n]) => h('th', null, n.label)))),
    h('tbody', null, PAISES_LISTA.map((p) => h('tr', null, h('td', null, h('strong', null, p)), ...nats.map(([k]) => {
      const s = sugerirIR(p, k);
      return h('td', null, h('div', null, h('strong', null, `${fmtNum(s.ir, 0)}%`), s.irMin != null && s.irMin !== s.ir ? h('span', { class: 'muted small' }, ` (até ${fmtNum(s.irMin, 0)}%)`) : null), chipS(s.status));
    }))))));
  const porPais = PAISES_LISTA.map((p) => {
    const detalhes = nats.map(([k, n]) => sugerirIR(p, k));
    return h('details', { class: 'explain' }, h('summary', null, p),
      h('div', { class: 'stack small' },
        h('p', null, h('strong', null, 'Tratado / lista: '), detalhes[0].tratado),
        ...detalhes.map((s) => h('p', null, h('strong', null, `${NATUREZAS[s.natureza].label}: ${fmtNum(s.ir, 0)}%`), ' ', chipS(s.status), ' ', s.nota, s.fontes.length ? h('span', null, ' Fontes: ', ...fontesNodes(s.fontes)) : null))));
  });
  const outros = Object.values(OUTROS).map((o) => h('div', { class: 'small' }, h('strong', null, `${o.label}${o.pct ? `: ${fmtNum(o.pct, 2)}%` : ''}`), ' ', chipS(o.status), ' ', o.nota, o.fontes.length ? h('span', null, ' Fontes: ', ...fontesNodes(o.fontes)) : null));
  fill(main,
    h('h1', null, 'Tributos por país'),
    h('p', { class: 'lead' }, 'Referência rápida do imposto de renda retido (IRRF) ao pagar serviços ao exterior e dos demais tributos da operação. Cada linha mostra o grau de confiança e a fonte. Nada aqui foi validado por contador.'),
    banner('warn', h('strong', null, 'Use para orçar, não para decidir sozinho. '), 'Onde há faixa (por exemplo 15% e "até 10%"), orce com o maior valor. As regras e as páginas de origem mudam: a lista de tributação favorecida que li só mostra alterações até 2017, e a Colômbia não teve os artigos do tratado lidos.'),
    tabela,
    h('h2', null, 'Detalhe por país'), h('div', { class: 'stack' }, ...porPais),
    h('h2', null, 'Outros tributos do serviço importado (a empresa recolhe)'),
    h('div', { class: 'card stack' }, ...outros, h('p', { class: 'small' }, h('strong', null, 'IBS e CBS: '), IBS_CBS, ' ', h('span', null, 'Fonte: '), ...fontesNodes(['lc214']))),
    h('h2', null, 'IOF'),
    h('div', { class: 'card stack small' }, h('p', null, h('strong', null, 'Pagamento ao exterior: 3,5% '), chipS('observado'), ' Cobrado pela XP e pelo Rendimento em 2026. O texto do Decreto 6.306 tem notas conflitantes (Decreto Legislativo 176/2025), mas os bancos aplicaram 3,5%.'),
      h('p', null, h('strong', null, 'Recebimento de exportação: 0% '), chipS('texto'), ' ', ...fontesNodes(['iof']))),
    h('h2', null, 'Exportação do Rompex'),
    h('div', { class: 'card stack small' }, ...EXPORTACAO.map((e) => h('p', null, h('strong', null, e.titulo + ': '), chipS(e.status), ' ', e.texto, e.fontes ? h('span', null, ' Fontes: ', ...fontesNodes(e.fontes)) : null))),
    h('h2', null, 'Pendente de confirmação'),
    h('div', { class: 'card stack small' }, h('ul', null,
      h('li', null, 'Alíquotas de IRRF por país conferidas por contador, especialmente serviço técnico e não técnico.'),
      h('li', null, 'Texto e vigência do tratado com a Colômbia, e a equiparação de serviço técnico a royalties no tratado com o Chile.'),
      h('li', null, 'Se a CIDE de 10% se aplica ao seu caso concreto (a cotação do banco não a inclui).'),
      h('li', null, 'Alíquota de ISS do seu município e tratamento de PIS/Cofins-importação (base e crédito).'),
      h('li', null, 'Tratamento tributário de uma NF-e de exportação do Rompex e a tarifa de importação em cada país de destino.'))));
}

// =============== Roteamento ===============
const VIEWS = { moedas: viewMoedas, noticias: viewNoticias, legislacao: viewLegislacao, agenda: viewAgenda, simulador: viewSimulador, tributos: viewTributos, alertas: viewAlertas, favoritos: viewFavoritos, config: viewConfig };

async function route() {
  const id = (location.hash.replace(/^#\//, '') || 'moedas').split('?')[0];
  const view = VIEWS[id] || viewMoedas;
  for (const [rid] of ROUTES) { const a = document.getElementById(`tab-${rid}`); if (a) { if (rid === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); } }
  const main = document.getElementById('main');
  fill(main, h('p', { class: 'muted' }, 'Carregando…'));
  try { await view(main); } catch (e) { if (e.message !== 'Sessão expirada') fill(main, errBox(e)); }
  main.focus({ preventScroll: true });
  clearInterval(state.timer);
  if (id !== 'moedas') clearInterval(state.live);
  if (id === 'moedas' && !state.static) state.timer = setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) view(main).catch(() => {}); }, 60000);
}

function showLogin(msg) {
  app.replaceChildren(h('form', { class: 'card login stack', onsubmit: async (e) => {
    e.preventDefault();
    try { await api('/login', { method: 'POST', body: { password: e.target.password.value } }); start(); } catch (err) { document.getElementById('lerr').textContent = err.message; }
  } }, h('h1', null, 'Monitor Econômico e Tributário'), h('p', { class: 'muted' }, msg || 'Informe a senha de acesso.'),
  h('label', { class: 'field' }, 'Senha', h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, autofocus: true })),
  h('div', { id: 'lerr', class: 'small', role: 'alert' }), h('button', { class: 'btn primary', type: 'submit' }, 'Entrar')));
}

async function start() {
  state.static = await initMode();
  if (state.static && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    [state.meta, state.status, state.prefs] = await Promise.all([api('/meta'), api('/status'), api('/prefs')]);
  } catch (e) { if (e.message !== 'Sessão expirada') app.replaceChildren(errBox(e)); return; }
  renderShell(); renderNotices(); await route();
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 60000);
}

window.addEventListener('auth-required', () => showLogin('Sua sessão expirou ou é necessário entrar.'));
window.addEventListener('hashchange', () => { if (state.meta) route(); });
start();
