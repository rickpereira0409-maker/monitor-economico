// Cálculos do simulador de remessa. Lógica pura (sem DOM), testada em test/calc.test.js.
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/**
 * Pagamento ao exterior (você compra moeda).
 * IOF incide sobre o valor em reais. IR com gross-up ("por conta do devedor"): o imposto é calculado sobre
 * valor_líquido / (1 − alíquota), como o banco fez na confirmação de 18/11/2026 (8.640,03 / 0,92 = 9.391,34; 8% = 751,31).
 */
export function simulate({ amount, rate, iofPct = 0, irPct = 0, grossUp = true, fee = 0 }) {
  const reais = r2(amount * rate);
  const iof = r2((reais * iofPct) / 100);
  const irBase = grossUp && irPct > 0 ? r2(reais / (1 - irPct / 100)) : reais;
  const ir = r2((irBase * irPct) / 100);
  const total = r2(reais + iof + ir + fee);
  return {
    reais, iof, irBase, ir, fee, total,
    vetSemIr: (reais + iof + fee) / amount, // o "VET" que o banco imprime: câmbio + IOF + tarifa em reais; NÃO inclui o IR
    vetComIr: total / amount,         // custo real por unidade de moeda estrangeira
    acimaDaTaxaPct: (total / reais - 1) * 100,
  };
}

/** Recebimento de exportação (você vende moeda ao banco). IOF zero para receitas de exportação (Dec. 6.306, art. 15-B, I). */
export function simulateReceipt({ amount, rate, fee = 0, iofPct = 0 }) {
  const reais = r2(amount * rate);
  const iof = r2((reais * iofPct) / 100);
  return { reais, iof, fee, liquido: r2(reais - iof - fee), taxaEfetiva: (reais - iof - fee) / amount };
}

/**
 * Confere uma confirmação de câmbio já emitida contra as alíquotas esperadas.
 * Retorna { esperado, achados: [{ nivel: 'erro'|'aviso'|'ok', texto }] }.
 */
export function checkConfirmation({ amount, rate, reais, iof, ir, iofPct, irPct, grossUp = true }, tol = 0.05) {
  const exp = simulate({ amount, rate, iofPct, irPct, grossUp });
  const achados = [];
  const money = (v) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const base = Number.isFinite(reais) && reais > 0 ? reais : exp.reais;
  if (Number.isFinite(reais) && reais > 0 && Math.abs(reais - exp.reais) > tol) achados.push({ nivel: 'aviso', texto: `Valor em reais (${money(reais)}) não bate com valor × taxa (${money(exp.reais)}).` });
  const e2 = simulate({ amount, rate: base / amount, iofPct, irPct, grossUp });
  if (iofPct > 0) {
    if (!(iof > 0)) achados.push({ nivel: 'erro', texto: `IOF não aparece na confirmação, mas era esperado ${money(e2.iof)} (${iofPct}%).` });
    else if (Math.abs(iof - e2.iof) > tol) achados.push({ nivel: 'erro', texto: `IOF cobrado (${money(iof)}) difere do esperado (${money(e2.iof)} a ${iofPct}%).` });
  }
  if (irPct > 0) {
    if (!(ir > 0.005)) achados.push({ nivel: 'erro', texto: `IR NÃO foi cobrado, mas era esperado ${money(e2.ir)} (${irPct}%${grossUp ? ' com gross-up' : ''}). Pode haver imposto devido sem retenção: fale com o contador e com o banco.` });
    else if (Math.abs(ir - e2.ir) > tol) achados.push({ nivel: 'erro', texto: `IR cobrado (${money(ir)}) difere do esperado (${money(e2.ir)}).` });
  }
  if (ir > 0.005) achados.push({ nivel: 'aviso', texto: `O VET impresso pelo banco normalmente não inclui o IR. Custo real por unidade: R$ ${e2.vetComIr.toFixed(4)} (total ${money(e2.total)}).` });
  if (!achados.some((a) => a.nivel === 'erro')) achados.unshift({ nivel: 'ok', texto: 'IOF e IR conferem com as alíquotas informadas.' });
  return { esperado: e2, achados };
}

/** Predefinições. status: 'observado' (visto em operação real), 'confirmado' (texto oficial lido) ou 'a confirmar'. */
export const PRESETS = [
  { id: 'xp-panama', modo: 'pagamento', nome: 'Pagamento ao exterior — como a XP cobrou em 19/11/2026 (Panamá, finalidade "Viagem internacional")', iofPct: 3.5, irPct: 8, grossUp: true, status: 'observado',
    nota: 'IOF 3,5% e IR 8% com gross-up foram os valores cobrados nessa operação. O IR depende da finalidade e do país: confirme com o contador antes de generalizar.' },
  { id: 'servico-geral', modo: 'pagamento', nome: 'Serviço ao exterior — como o Rendimento cobrou (Paraguai, maio/2026, finalidade 46978)', iofPct: 3.5, irPct: 15, grossUp: true, status: 'observado',
    nota: 'Cotação do Banco Rendimento para serviço ao Paraguai: IOF 3,5% e IR 15% com gross-up (DARF 0422, 17,647% sobre o valor líquido), mais tarifa em reais. A cotação do banco não inclui outros tributos de serviço importado (PIS/Cofins-importação, ISS, CIDE), que a empresa apura: confirme com o contador. Outros países (com tratado) podem ter alíquota diferente.' },
  { id: 'exportacao', modo: 'recebimento', nome: 'Recebimento de exportação (IOF zero)', iofPct: 0, irPct: 0, grossUp: false, status: 'confirmado',
    nota: 'IOF zero para ingresso de receitas de exportação: Decreto 6.306/2007, art. 15-B, inciso I.' },
];
