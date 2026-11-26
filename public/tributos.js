// Tributos sobre pagamentos ao exterior, por país e natureza. Lógica pura (sem DOM), testada em test/tributos.test.js.
// Pesquisado em 26/11/2026 em textos oficiais e fontes secundárias. NADA aqui foi validado por contador:
// cada regra carrega o seu grau de confiança. Quando mudar a lei, edite este arquivo.
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

export const STATUS = {
  observado: { label: 'Observado em operação real', cls: 'ok' },
  texto: { label: 'Texto oficial lido', cls: 'info' },
  confirmar: { label: 'A confirmar', cls: 'warn' },
};

export const FONTES = {
  in1455: ['IN RFB 1.455/2014 (versão de 2014; vigência atual não confirmada)', 'https://www.contabeis.com.br/legislacao/65386/instrucao-normativa-rfb-1455-2014/'],
  in1037: ['IN RFB 1.037/2010 – lista de tributação favorecida (páginas só até 2017)', 'https://www.normasbrasil.com.br/norma/?id=78049'],
  lei14537: ['Lei 14.537/2023 – IRRF reduzido em remessas de viagem', 'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2023/lei/L14537.htm'],
  argentina: ['Decreto 9.482/2018 – protocolo Brasil-Argentina', 'https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/decreto/D9482.htm'],
  chile: ['Decreto 12.863/2026 – protocolo Brasil-Chile', 'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2026/decreto/d12863.htm'],
  peru: ['Decreto 7.020/2009 – convenção Brasil-Peru (com protocolo)', 'https://www.planalto.gov.br/ccivil_03/_ato2007-2010/2009/decreto/d7020.htm'],
  chile2003: ['Decreto 4.852/2003 – convenção Brasil-Chile', 'https://planalto.gov.br/ccivil_03/decreto/2003/D4852.htm'],
  colombia: ['Decreto Legislativo 193/2025 – convenção Brasil-Colômbia (só aprovação; texto e vigência não lidos)', 'https://www2.camara.leg.br/legin/fed/decleg/2025/decretolegislativo-193-2-setembro-2025-797919-convencao-176284-pl.html'],
  adi5: ['ADI RFB 5/2014 – serviços técnicos e tratados', 'https://www.legisweb.com.br/legislacao/?id=271673'],
  cide: ['Lei 10.168/2000 – CIDE-Remessas', 'https://www2.camara.leg.br/legin/fed/lei/2000/lei-10168-29-dezembro-2000-363261-normaatualizada-pl.html'],
  cideStf: ['STF valida a CIDE-Remessas (Tema 914, 2025)', 'https://noticias.stf.jus.br/?p=125356'],
  pisCofins: ['Lei 10.865/2004 – PIS/Cofins-Importação', 'https://www.planalto.gov.br/ccivil_03/_ato2004-2006/2004/lei/l10.865compilado.htm'],
  lc214: ['LC 214/2025 – IBS e CBS (importação de serviços)', 'https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214.htm'],
  iof: ['Decreto 6.306/2007 – IOF-Câmbio, art. 15-B', 'https://www.planalto.gov.br/ccivil_03/_ato2007-2010/2007/decreto/d6306.htm'],
  reintegra: ['Reintegra (resumo)', 'https://www.contabeis.com.br/tudo-sobre/reintegra'],
};

export const NATUREZAS = {
  tecnico: { label: 'Serviço técnico, assistência técnica ou consultoria', cide: true, piscofins: true, iss: true },
  servico: { label: 'Outro serviço (não técnico)', cide: false, piscofins: true, iss: true },
  royalties: { label: 'Royalties, licença de software ou marca', cide: true, piscofins: true, iss: false },
  viagem: { label: 'Viagem: hotel, passagens e gastos de viagem', cide: false, piscofins: false, iss: false },
  mercadoria: { label: 'Importação de mercadoria', cide: false, piscofins: false, iss: false },
};

export const PAISES_LISTA = ['Paraguai', 'Panamá', 'Bolívia', 'Argentina', 'Chile', 'Colômbia', 'Peru', 'Outro país'];

const PAISES = {
  Paraguai: { favorecida: false, tratado: 'Não encontrei convenção de imposto de renda com o Paraguai.',
    over: { tecnico: { status: 'observado', nota: 'Cobrado pelo Banco Rendimento em maio/2026 para serviço ao Paraguai (DARF 0422, 15% com gross-up).' } } },
  Panamá: { favorecida: true, tratado: 'Não encontrei convenção de imposto de renda com o Panamá (uma fonte secundária citava o Decreto 10.705/2021, mas ele é com os Emirados Árabes Unidos). O Panamá consta na lista de tributação favorecida (IN RFB 1.037/2010, item XLII; páginas só até 2017).',
    over: { viagem: { status: 'observado', nota: 'A XP cobrou 8% sobre o hotel (19/11/2026). Vale até R$ 20 mil por mês; 9% em 2027. A taxa do evento pode não se enquadrar como gasto de viagem: confirme com o contador.' } } },
  Bolívia: { favorecida: false, tratado: 'Não encontrei convenção de imposto de renda com a Bolívia.', over: {} },
  Argentina: { favorecida: false, tratado: 'Convenção de 1980 (Dec. 87.976/1982) e protocolo de 2017 (Dec. 9.482/2018; retenção na fonte desde 1/1/2019).',
    over: {
      tecnico: { ir: 15, irMin: 10, status: 'texto', fontes: ['argentina', 'adi5'], nota: 'O protocolo equipara serviço técnico e assistência técnica a royalties (art. XII): teto de 15%; 10% só se houver contrato de transferência de tecnologia registrado.' },
      royalties: { ir: 15, irMin: 10, status: 'texto', fontes: ['argentina'], nota: 'Royalties: teto de 15% (marcas) ou 10% (demais casos), com condições no protocolo.' },
      servico: { ir: 25, irMin: 0, status: 'confirmar', fontes: ['argentina', 'adi5'], nota: 'Pelo art. VII, lucros de empresa argentina sem estabelecimento permanente só são tributados na Argentina, e a Receita (ADI 5/2014) só deixa de reter nessa hipótese residual. Orce com 25% e confirme se o serviço realmente cai no art. VII.' },
    } },
  Chile: { favorecida: false, tratado: 'Convenção (Dec. 4.852/2003) e protocolo de 2022 (Dec. 12.863/2026; em vigor para o Brasil em 30/10/2025, retenção na fonte desde 1/1/2026).',
    over: {
      tecnico: { ir: 15, irMin: 10, status: 'texto', fontes: ['chile2003', 'chile', 'adi5'], nota: 'Protocolo de 2001, item 5 (lido): o §3 do art. 12 (royalties) se aplica a serviços técnicos e assistência técnica. O teto do art. 12 §2 era 15% e, pelo protocolo de 2022, é 10% para royalties em geral (15% para marcas), com efeitos desde 1/1/2026. Aplicar o §2 aos serviços é a leitura da Receita (ADI 5/2014); orce com 15% e confirme se cabe 10%.' },
      royalties: { ir: 15, irMin: 10, status: 'texto', fontes: ['chile'], nota: 'Protocolo de 2022, art. 6: 15% (marcas) e 10% (demais royalties), com efeitos para pagamentos a partir de 1/1/2026.' },
      servico: { ir: 25, irMin: 0, status: 'confirmar', fontes: ['chile2003', 'adi5'], nota: 'Art. 7: lucros só são tributados no residente sem estabelecimento permanente. Art. 14 (serviços profissionais independentes) permite tributar na fonte se a remuneração for paga por residente do outro país, e a convenção não fixa alíquota. Orce com 25% e confirme o enquadramento.' },
    } },
  Colômbia: { favorecida: false, tratado: 'Convenção assinada em 2022 e aprovada pelo Congresso (PDL 311/2024, que virou o Decreto Legislativo 193/2025, de 2/9/2025). Li só o registro legislativo: o texto dos artigos, o decreto de promulgação e as datas de efeito não estavam acessíveis.',
    over: {
      tecnico: { status: 'confirmar', fontes: ['colombia', 'adi5'], nota: 'Se a convenção já valer, pode haver teto de retenção menor. Sem alíquota confirmada: usando a regra interna.' },
      servico: { status: 'confirmar', fontes: ['colombia', 'adi5'], nota: 'Sem alíquota confirmada para a convenção: usando a regra interna.' },
      royalties: { status: 'confirmar', fontes: ['colombia'], nota: 'Sem alíquota confirmada para a convenção: usando a regra interna.' },
    } },
  Peru: { favorecida: false, tratado: 'Convenção de 2006 (Dec. 7.020/2009), em vigor internacionalmente desde 14/08/2009; retenção na fonte a partir de 1/1/2010 (leitura do art. 28). Sem protocolo ou emenda posterior nos textos lidos.',
    over: {
      tecnico: { ir: 15, irMin: null, status: 'texto', fontes: ['peru', 'adi5'], nota: 'Protocolo, item 4 (lido): serviços técnicos e assistência técnica, inclusive serviços digitais e empresariais e consultorias, recebem o tratamento de royalties (art. 12): teto de 15%.' },
      royalties: { ir: 15, irMin: null, status: 'texto', fontes: ['peru'], nota: 'Art. 12 §2 (lido): teto de 15% do valor bruto.' },
      servico: { ir: 15, irMin: 0, status: 'confirmar', fontes: ['peru', 'adi5'], nota: 'O protocolo cobre serviços empresariais e consultorias com teto de 15%. Serviço fora desse conceito iria para o art. 7 (sem retenção) ou para a regra interna (25%): confirme o enquadramento.' },
    } },
  'Outro país': { favorecida: null, tratado: 'Verifique se há convenção com o país e se ele consta na lista de tributação favorecida.', over: {}, genericoConfirmar: true },
};

const DOM = (nat, fav) => (nat === 'viagem' ? 8 : nat === 'mercadoria' ? 0 : fav ? 25 : nat === 'tecnico' || nat === 'royalties' ? 15 : 25);

/** IR sugerido para (país, natureza). irMin = valor possível se um tratado ou condição se aplicar. */
export function sugerirIR(pais, natureza) {
  const p = PAISES[pais];
  if (!p || !NATUREZAS[natureza]) return null;
  const base = DOM(natureza, p.favorecida);
  const o = p.over[natureza] || {};
  let status = o.status;
  let nota = o.nota;
  let fontes = o.fontes;
  if (!status) {
    if (natureza === 'mercadoria') { status = 'confirmar'; nota = 'Pagamento de importação de mercadoria normalmente não sofre IRRF: confirme com o contador.'; fontes = []; }
    else if (natureza === 'viagem') { status = 'texto'; nota = 'Lei 14.537/2023: remessa para gastos de viagem até R$ 20 mil por mês paga 8% em 2026 (9% em 2027). A lei remete os detalhes a um ato do Executivo que não li.'; fontes = ['lei14537']; }
    else { status = p.genericoConfirmar ? 'confirmar' : 'texto'; fontes = p.favorecida ? ['in1455', 'in1037'] : ['in1455']; nota = p.favorecida ? 'País de tributação favorecida: 25% (IN 1.455/2014, art. 17 §3º e art. 19).' : natureza === 'servico' ? 'Regra geral para serviço que não é técnico: 25% (IN 1.455/2014, art. 16).' : 'Serviço técnico, assistência técnica e royalties: 15% (IN 1.455/2014, art. 17).'; }
  }
  if (!fontes) fontes = natureza === 'viagem' ? ['lei14537'] : natureza === 'mercadoria' ? [] : p.favorecida ? ['in1455', 'in1037'] : ['in1455'];
  return { pais, natureza, ir: o.ir ?? base, irMin: o.irMin ?? null, status, nota, fontes: fontes || [], tratado: p.tratado, favorecida: p.favorecida };
}

export const OUTROS = {
  cide: { label: 'CIDE-Remessas', pct: 10, status: 'texto', fontes: ['cide', 'cideStf'], nota: '10% sobre remessas de royalties, serviços técnicos e assistência técnica/administrativa. O STF validou a cobrança em 2025 (Tema 914) e o CARF entende que incide mesmo sem transferência de tecnologia. Não costuma entrar na cotação do banco.' },
  pis: { label: 'PIS-Importação', pct: 1.65, status: 'texto', fontes: ['pisCofins'], nota: 'Na importação de serviço, a base inclui o ISS e as próprias contribuições; há decisão do TRF3 (2025) excluindo o ISS da base. Estimativa simplificada sobre o valor em reais.' },
  cofins: { label: 'Cofins-Importação', pct: 7.6, status: 'texto', fontes: ['pisCofins'], nota: 'Alguns casos têm 1 ponto adicional, sem crédito. No Lucro Real, PIS e Cofins-importação costumam gerar crédito (confirme).' },
  iss: { label: 'ISS na importação de serviço', pct: 0, status: 'confirmar', fontes: [], nota: 'Não se aplica ao seu caso, segundo você: o padrão é zero e ele não entra no total. Se o contador disser o contrário, informe a alíquota do município (a sua foi citada como 3%; o limite legal geral é de 2% a 5%).' },
};

/** Tributos que a EMPRESA apura (fora da cotação do banco), em estimativa simplificada sobre o valor em reais. */
export function calcOutros({ reais, natureza, cide = OUTROS.cide.pct, pis = OUTROS.pis.pct, cofins = OUTROS.cofins.pct, iss = OUTROS.iss.pct }) {
  const n = NATUREZAS[natureza];
  if (!n) return null;
  const itens = [];
  const add = (k, pct) => { if (pct > 0) itens.push({ id: k, label: OUTROS[k].label, pct, valor: r2((reais * pct) / 100), status: OUTROS[k].status }); };
  if (n.cide) add('cide', cide);
  if (n.piscofins) { add('pis', pis); add('cofins', cofins); }
  if (n.iss) add('iss', iss);
  const total = r2(itens.reduce((a, i) => a + i.valor, 0));
  const creditavel = r2(itens.filter((i) => i.id === 'pis' || i.id === 'cofins').reduce((a, i) => a + i.valor, 0));
  return { itens, total, creditavel };
}

export const EXPORTACAO = [
  { titulo: 'Rompex: NCM', texto: 'NCM 3824.99.79, nas suas NF-e de venda e de exportação ("Rompex Modelo VI … fragmentador de rochas"). Carga perigosa: ONU 3178, classe 4.1.', status: 'observado' },
  { titulo: 'IOF no recebimento da exportação', texto: 'Alíquota zero (Decreto 6.306/2007, art. 15-B, inciso I). Alcança exportação de bens e serviços.', status: 'texto', fontes: ['iof'] },
  { titulo: 'ICMS, IPI, PIS e Cofins na sua exportação', texto: 'NF-e 4834 (Peru, CFOP 7101, 20/03/2026): ICMS "não tributado" (CF, art. 155, §2º, X, "a"), IPI imune (CF, art. 153, §3º, III) e PIS/Cofins zerados. É o que a nota mostra: créditos e benefícios (por exemplo, Reintegra) não aparecem nela.', status: 'observado' },
  { titulo: 'Recebimento da exportação', texto: 'A NF-e está em reais, com prazo de 30 dias ("CREDPLUS"). Falta a invoice comercial em moeda estrangeira e o contrato de câmbio do recebimento para conferir a taxa e o IOF zero na prática.', status: 'confirmar' },
  { titulo: 'Reintegra', texto: 'Devolução de resíduos tributários a exportadores, com alíquota entre 0,1% e 3% definida pelo Executivo (o STF discute a variação). O Decreto 12.565/2025 elevou a alíquota para 3% só para MEI, microempresas e empresas de pequeno porte; a alíquota de 2026 para Lucro Real e o direito da Lake ao benefício não foram confirmados.', status: 'confirmar', fontes: ['reintegra'] },
  { titulo: 'Imposto de importação nos países de destino', texto: 'Depende do país e do acordo comercial (Mercosul/ALADI) e costuma exigir certificado de origem. Ainda não pesquisei por país para o NCM 3824.99.79.', status: 'confirmar' },
];

export const IBS_CBS = 'Importação de serviço passa a ter IBS e CBS (LC 214/2025): a alíquota é a mesma do serviço prestado no país, o adquirente é o contribuinte e o ISS não entra na base. Em 2026 há fase de teste (CBS 0,9% e IBS 0,1%, compensados com PIS/Cofins). A alíquota de 2027 e a substituição do ISS e do PIS/Cofins-importação ainda não foram confirmadas aqui.';
