// Leitor de invoice: extrai valor, moeda, país, natureza e itens de um TEXTO. Lógica pura, testada em test/invoice.test.js.
// É uma sugestão a ser conferida pelo usuário: layouts de invoices variam muito.
const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const CURRENCIES = [
  ['USD', /\b(USD|US\$|U\$S|DOLARES?|DOLLARS?)\b/i], ['EUR', /\b(EUR|€|EUROS?)\b/i], ['GBP', /\b(GBP|£)\b/i], ['CNY', /\b(CNY|RMB|YUAN)\b/i],
  ['ARS', /\b(ARS)\b/i], ['PYG', /\b(PYG|GUARAN[IÍ]ES?)\b/i], ['CLP', /\b(CLP)\b/i], ['COP', /\b(COP)\b/i], ['BOB', /\b(BOB)\b/i],
];

const COUNTRIES = [
  ['Paraguai', ['paraguay', 'paraguai', 'asuncion', 'ciudad del este']], ['Panamá', ['panama', 'ciudad de panama']],
  ['Argentina', ['argentina', 'buenos aires', 'cordoba']], ['Chile', ['chile', 'santiago de chile', 'santiago, chile']],
  ['Colômbia', ['colombia', 'bogota', 'medellin']], ['Bolívia', ['bolivia', 'la paz', 'santa cruz de la sierra']],
  ['Uruguai', ['uruguay', 'montevideo']], ['Peru', ['peru', 'lima, peru']], ['México', ['mexico']],
  ['Estados Unidos', ['united states', 'usa', 'u.s.a', 'miami', 'new york', 'florida']], ['China', ['china', 'shanghai', 'shenzhen', 'beijing']],
  ['Alemanha', ['germany', 'alemania', 'deutschland']], ['Espanha', ['spain', 'espana', 'madrid']],
];

/** Interpreta "1.486,87", "1,486.87", "3.415,00", "3415.00" e "1.486" (milhar). */
export function parseAmount(raw) {
  const s = String(raw).replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let dec = null;
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',', tail = s.length - s.lastIndexOf(sep) - 1, count = s.split(sep).length - 1;
    dec = tail !== 3 || count > 1 ? (count > 1 ? null : sep) : null; // "1.486" = milhar; "1.48" = decimal
    if (tail === 3 && count === 1) dec = null;
  }
  const n = dec ? Number(s.replace(dec === '.' ? /,/g : /\./g, '').replace(dec, '.')) : Number(s.replace(/[.,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function currencyIn(text) {
  for (const [code, re] of CURRENCIES) if (re.test(text)) return code;
  return null;
}

const AMOUNT = '([\\d][\\d.,]*\\d)';
function findTotal(text) {
  const lines = text.split(/\r?\n/);
  const patterns = [/total\s*(?:a pagar|due|general)?\s*:?/i, /payment due\s*:?/i, /amount due\s*:?/i, /valor\s*:?/i];
  for (const p of patterns) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!p.test(lines[i])) continue;
      const m = new RegExp(`(USD|US\\$|U\\$S|EUR|€|GBP|£|CNY|ARS|PYG|CLP|COP|BOB)?\\s*${AMOUNT}\\s*(USD|EUR|GBP)?`, 'i').exec(lines[i].replace(/^.*?(total|payment due|amount due|valor)[^\d]*/i, ''));
      const amount = m ? parseAmount(m[2]) : null;
      if (amount != null && amount > 0) return { amount, currency: currencyIn(`${m[1] || ''} ${m[3] || ''} ${lines[i]}`), line: lines[i].trim() };
    }
  }
  return null;
}

const BANK_LINE = /swift|aba\b|iban|banco|bank|conta|account|campo\s*\d+/i;
export function detectCountry(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const hit = (chunk) => { const t = strip(chunk); return COUNTRIES.filter(([, keys]) => keys.some((k) => new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(t))).map(([n]) => n); };
  const head = hit(lines.slice(0, 6).join(' '));
  if (head.length) return { country: head[0], source: 'cabeçalho (emissor)', all: head };
  const body = hit(lines.filter((l) => !BANK_LINE.test(l)).join(' '));
  if (body.length) return { country: body[0], source: 'corpo do documento', all: body };
  const any = hit(text);
  return any.length ? { country: any[0], source: 'dados bancários (menos confiável)', all: any } : { country: null, source: null, all: [] };
}

const NATUREZAS = [
  ['viagem', /hotel|room|quarto|habitaci|aloja|lodging|flight|passagem|pasaje|airfare|viagem|travel|viaje|meal|alimenta/i],
  ['servico', /servic|service|honorari|consult|assessor|asesor|event|evento|inscri|registration|fee\b|license|licen|software|support|soporte|training|capacita|analysis|analisis|an[aá]lise/i],
  ['mercadoria', /product|producto|mercador|goods|unit price|precio unitario|fob|cif|pcs|pieces|material|equipment|equipamento|lote/i],
];
const classify = (desc) => NATUREZAS.find(([, re]) => re.test(desc))?.[0] ?? 'outro';

function parseItems(text) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    // Tabela em texto com "|" ou, vindo de PDF, colunas separadas por 2+ espaços.
    const cells = (line.includes('|') ? line.split('|') : line.split(/\s{2,}/)).map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 3) {
      const last = cells[cells.length - 1], amt = /\d/.test(last) ? parseAmount(last.replace(/[^\d.,]/g, '')) : null;
      const desc = cells.slice(1, -1).join(' ');
      if (amt != null && /[a-zA-Z]{3,}/.test(desc) && !/descri|description|valor/i.test(desc)) items.push({ descricao: desc, valor: amt, natureza: classify(desc) });
    }
  }
  return items.length ? items : parseItemsLoose(text);
}

const AMT_END = /(?:USD|US\$|U\$S|EUR|€|GBP|£|CNY|ARS|PYG|CLP|COP|BOB)\s*([\d][\d.,]*\d)\s*$/i;
const TOTALISH = /total|payment due|amount due|subtotal|saldo/i;

/** Para texto vindo de PDF, onde a linha de uma tabela pode quebrar: liga cada "MOEDA valor" à descrição das linhas anteriores. */
function parseItemsLoose(text) {
  const items = []; let buf = [];
  for (const raw of text.split(/\r?\n/)) {
    const L = raw.trim();
    if (!L) continue;
    if (TOTALISH.test(L)) { buf = []; continue; }
    const m = AMT_END.exec(L);
    if (m) {
      const valor = parseAmount(m[1]);
      const desc = [...buf.slice(-2), L.slice(0, m.index)].join(' ').replace(/\b(valor|value|monto)\s*:/gi, ' ').replace(/^\s*(\d{1,3}\s+)/, '').replace(/\s+/g, ' ').trim();
      if (valor != null && /[a-zA-Z]{3,}/.test(desc)) items.push({ descricao: desc, valor, natureza: classify(desc) });
      buf = [];
    } else if (!/^(qtd|qty|cant|descri)/i.test(L)) buf.push(L);
  }
  return items;
}

export function parseInvoice(text) {
  const t = String(text ?? '');
  const total = findTotal(t);
  const items = parseItems(t);
  const country = detectCountry(t);
  const numero = /(?:invoice|factura|fatura)\s*(?:n[°ºo.]*|no\.?|#|num(?:ero|\.)?)\s*:?\s*([A-Z0-9][\w\-/.]*)/i.exec(t)?.[1] ?? /#\s*:?\s*([\w\-/.]+)/.exec(t)?.[1] ?? null;
  const data = /(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
  const avisos = [];
  const header = t.split(/\r?\n/).slice(0, 4).join(' ');
  const nat = items.length ? [...new Set(items.map((i) => i.natureza))] : [classify(t)];
  if (/proforma/i.test(header) || /proforma/i.test(t.slice(0, 200))) avisos.push('É uma PROFORMA (documento estimativo), não a fatura final do fornecedor. Confirme com o contador/banco se serve para o câmbio e para comprovar a despesa.');
  if (!/swift|iban|aba\b|conta|account|cuenta/i.test(t)) avisos.push('Não há dados bancários para pagamento na invoice.');
  if (items.length) {
    const soma = Math.round(items.reduce((a, i) => a + i.valor, 0) * 100) / 100;
    if (total && Math.abs(soma - total.amount) > 0.01) avisos.push(`A soma dos itens (${soma}) não bate com o total (${total.amount}).`);
  }
  if (new Set(nat.filter((n) => n !== 'outro')).size > 1) avisos.push('Mistura naturezas diferentes (ex.: viagem e serviço). O IR e outros tributos podem ser diferentes para cada parte: avalie separar o pagamento.');
  if (country.country && country.source?.startsWith('dados bancários')) avisos.push('País deduzido só dos dados bancários: confira o país do fornecedor.');
  if (!country.country) avisos.push('Não consegui identificar o país do fornecedor.');
  if (!total) avisos.push('Não encontrei o valor total.');
  const por = {};
  for (const i of items) por[i.natureza] = Math.round(((por[i.natureza] || 0) + i.valor) * 100) / 100;
  return {
    valor: total?.amount ?? null, moeda: total?.currency ?? currencyIn(t), pais: country.country, paisFonte: country.source, numero, data: data ? `${data[3]}-${data[2]}-${data[1]}` : null,
    natureza: nat.length === 1 ? nat[0] : 'misto', itens: items, valorPorNatureza: por, avisos,
  };
}
