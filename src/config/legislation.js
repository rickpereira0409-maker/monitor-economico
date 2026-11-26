// Proposições acompanhadas por padrão. A SITUAÇÃO (etapa, última movimentação) vem sempre da API da Câmara;
// os campos abaixo (regimes, setores, tributos, notas, o que acompanhar) são CLASSIFICAÇÃO EDITORIAL deste sistema,
// não informação oficial. Confirme no texto da norma antes de decidir.
//
// regimes: 'todos' | lista de 'MEI' | 'Simples Nacional' | 'Lucro Presumido' | 'Lucro Real' | ['indeterminado']
export const TRACKED = [
  {
    sigla: 'PEC', numero: 45, ano: 2019,
    title: 'Reforma tributária sobre o consumo (PEC 45/2019 → Emenda Constitucional 132/2023)',
    regimes: ['todos'], setores: ['todos'], ufs: ['todas'],
    tributos: ['IBS', 'CBS', 'Imposto Seletivo', 'ICMS', 'ISS', 'PIS', 'Cofins', 'IPI'],
    notes: 'Alterou a Constituição para criar IBS, CBS e Imposto Seletivo e extinguir gradualmente ICMS, ISS, PIS, Cofins e (em parte) IPI. A aplicação prática depende das leis complementares de regulamentação.',
    watch: 'Acompanhe as leis complementares e a regulamentação infralegal; a emenda sozinha não define alíquotas.',
  },
  {
    sigla: 'PLP', numero: 68, ano: 2024,
    title: 'Regulamentação do IBS, da CBS e do Imposto Seletivo (PLP 68/2024)',
    regimes: ['todos'], setores: ['todos'], ufs: ['todas'],
    tributos: ['IBS', 'CBS', 'Imposto Seletivo'],
    notes: 'Primeira lei complementar de regulamentação da reforma. Há regras específicas para o Simples Nacional e MEI (opção por recolher IBS/CBS fora do regime unificado) e para diversos setores (regimes específicos e alíquotas reduzidas).',
    watch: 'Verifique a norma já publicada, vetos, prazos de transição e as regulamentações complementares (Receita Federal e Comitê Gestor).',
  },
  {
    sigla: 'PLP', numero: 108, ano: 2024,
    title: 'Comitê Gestor do IBS e ajustes na regulamentação (PLP 108/2024)',
    regimes: ['todos'], setores: ['todos'], ufs: ['todas'],
    tributos: ['IBS', 'ITCMD', 'Processo administrativo tributário'],
    notes: 'Segunda etapa da regulamentação: institui o Comitê Gestor do IBS, trata do processo administrativo tributário do IBS e da repartição da arrecadação entre estados e municípios.',
    watch: 'Confirme a situação atual na fonte oficial: este projeto pode ter tramitado também no Senado, com movimentações que a API da Câmara nem sempre detalha.',
  },
  {
    sigla: 'PL', numero: 1087, ano: 2025,
    title: 'Imposto de Renda: faixa de isenção e tributação de altas rendas/dividendos (PL 1087/2025)',
    regimes: ['Lucro Presumido', 'Lucro Real'], setores: ['todos'], ufs: ['todas'],
    tributos: ['IRPF', 'IRRF sobre dividendos', 'IRPJ'],
    notes: 'Afeta principalmente sócios de empresas (distribuição de lucros e dividendos) e rotinas de retenção na fonte; o efeito direto sobre o IRPJ da empresa deve ser verificado no texto. Aplicação a MEI e Simples Nacional: não determinada por este sistema.',
    watch: 'Verifique datas de início de vigência e regras de transição para dividendos.',
  },
];

// Marcos com data prevista em norma. Cada marco cita a fonte para conferência. O sistema os trata como
// "previsto em lei" (não como fato ocorrido) e os usa na agenda e nos lembretes.
export const MARCOS = [
  // Intencionalmente vazio no código: marcos só entram com data e fonte conferidas por uma pessoa
  // (Agenda > Adicionar). Evita publicar prazo de memória. Ver README, seção "Agenda e prazos".
];

// Busca automática de novas proposições relacionadas a tributos (classificação de aplicação: indeterminada).
export const DISCOVERY = {
  keywords: ['reforma tributária', 'Imposto sobre Bens e Serviços', 'Simples Nacional', 'Imposto Seletivo', 'microempreendedor individual'],
  tipos: ['PLP', 'PL', 'PEC', 'MPV'],
  taxRegex: /tribut|imposto|contribui[cç][aã]o|IBS|CBS|simples nacional|microempreendedor|\bMEI\b|lucro presumido|lucro real|fiscal|aduane|importa[cç][aã]o|exporta[cç][aã]o|ICMS|\bISS\b|IPI|IOF|PIS|Cofins|Receita Federal/i,
  perKeyword: 8,
};
