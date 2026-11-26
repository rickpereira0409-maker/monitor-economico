import test from 'node:test';
import assert from 'node:assert/strict';
import { sugerirIR, calcOutros, NATUREZAS, PAISES_LISTA, STATUS, FONTES, OUTROS } from '../public/tributos.js';

test('Paraguai: serviço técnico 15% observado (Rendimento); outro serviço 25% pela IN 1.455', () => {
  const t = sugerirIR('Paraguai', 'tecnico');
  assert.equal(t.ir, 15); assert.equal(t.status, 'observado');
  assert.deepEqual(t.fontes, ['in1455'], 'mesmo com nota observada, cita a norma');
  const s = sugerirIR('Paraguai', 'servico');
  assert.equal(s.ir, 25); assert.equal(s.status, 'texto');
});

test('Panamá: país de tributação favorecida paga 25% em serviço; viagem 8% (observado na XP)', () => {
  assert.equal(sugerirIR('Panamá', 'tecnico').ir, 25);
  assert.equal(sugerirIR('Panamá', 'servico').ir, 25);
  assert.equal(sugerirIR('Panamá', 'royalties').ir, 25);
  const v = sugerirIR('Panamá', 'viagem');
  assert.equal(v.ir, 8); assert.equal(v.status, 'observado');
  assert.equal(sugerirIR('Panamá', 'tecnico').favorecida, true);
});

test('Argentina e Chile: tratado dá faixa (irMin) e serviço não técnico fica "a confirmar"', () => {
  const at = sugerirIR('Argentina', 'tecnico');
  assert.equal(at.ir, 15); assert.equal(at.irMin, 10); assert.equal(at.status, 'texto');
  const as = sugerirIR('Argentina', 'servico');
  assert.equal(as.ir, 25); assert.equal(as.irMin, 0); assert.equal(as.status, 'confirmar');
  const ct = sugerirIR('Chile', 'tecnico');
  assert.equal(ct.ir, 15); assert.equal(ct.irMin, 10); assert.equal(ct.status, 'texto', 'item 5 do protocolo de 2001 lido literalmente');
  assert.equal(sugerirIR('Chile', 'royalties').status, 'texto');
});

test('Colômbia e Outro país usam a regra interna, marcados como a confirmar', () => {
  const c = sugerirIR('Colômbia', 'tecnico');
  assert.equal(c.ir, 15); assert.equal(c.status, 'confirmar'); assert.equal(c.irMin, null);
  assert.equal(sugerirIR('Colômbia', 'servico').ir, 25);
  const o = sugerirIR('Outro país', 'tecnico');
  assert.equal(o.ir, 15); assert.equal(o.status, 'confirmar');
});

test('Peru: tratado em vigor equipara serviços técnicos e consultorias a royalties, teto de 15%', () => {
  const t = sugerirIR('Peru', 'tecnico');
  assert.equal(t.ir, 15); assert.equal(t.status, 'texto'); assert.deepEqual(t.fontes, ['peru', 'adi5']);
  assert.equal(sugerirIR('Peru', 'royalties').ir, 15);
  const s = sugerirIR('Peru', 'servico');
  assert.equal(s.ir, 15); assert.equal(s.irMin, 0); assert.equal(s.status, 'confirmar');
  assert.ok(PAISES_LISTA.includes('Peru'));
});

test('Panamá: sem tratado; a nota explica o engano de uma fonte secundária', () => {
  assert.match(sugerirIR('Panamá', 'tecnico').tratado, /Emirados/);
});

test('Bolívia segue a regra geral; mercadoria 0% a confirmar; viagem 8% pela Lei 14.537', () => {
  assert.equal(sugerirIR('Bolívia', 'tecnico').ir, 15);
  assert.equal(sugerirIR('Bolívia', 'servico').ir, 25);
  const m = sugerirIR('Bolívia', 'mercadoria');
  assert.equal(m.ir, 0); assert.equal(m.status, 'confirmar');
  const v = sugerirIR('Bolívia', 'viagem');
  assert.equal(v.ir, 8); assert.deepEqual(v.fontes, ['lei14537']);
});

test('entradas inválidas retornam null; toda combinação válida tem status e fontes conhecidas', () => {
  assert.equal(sugerirIR('Marte', 'tecnico'), null);
  assert.equal(sugerirIR('Paraguai', 'xyz'), null);
  for (const p of PAISES_LISTA) for (const n of Object.keys(NATUREZAS)) {
    const s = sugerirIR(p, n);
    assert.ok(s, `${p}/${n}`);
    assert.ok(STATUS[s.status], `${p}/${n} status`);
    assert.ok(Number.isFinite(s.ir) && s.ir >= 0 && s.ir <= 25, `${p}/${n} ir`);
    for (const f of s.fontes) assert.ok(FONTES[f], `fonte ${f}`);
  }
});

test('calcOutros: serviço técnico do Paraguai (R$ 17.314,05) tem CIDE, PIS e Cofins', () => {
  const o = calcOutros({ reais: 17314.05, natureza: 'tecnico', iss: 0 });
  const v = Object.fromEntries(o.itens.map((i) => [i.id, i.valor]));
  assert.equal(v.cide, 1731.41); assert.equal(v.pis, 285.68); assert.equal(v.cofins, 1315.87);
  assert.equal(o.total, 3332.96);
  assert.equal(o.creditavel, 1601.55, 'PIS + Cofins, possível crédito no Lucro Real');
  assert.equal(o.itens.some((i) => i.id === 'iss'), false, 'ISS só entra se a alíquota for informada');
});

test('calcOutros: outro serviço não paga CIDE; ISS entra quando informado; viagem e mercadoria não têm esses tributos', () => {
  const s = calcOutros({ reais: 10000, natureza: 'servico', iss: 3 });
  assert.deepEqual(s.itens.map((i) => i.id), ['pis', 'cofins', 'iss']);
  assert.equal(s.itens.find((i) => i.id === 'iss').valor, 300);
  assert.equal(calcOutros({ reais: 1000, natureza: 'viagem' }).total, 0);
  assert.equal(calcOutros({ reais: 1000, natureza: 'mercadoria' }).itens.length, 0);
  const r = calcOutros({ reais: 10000, natureza: 'royalties' });
  assert.deepEqual(r.itens.map((i) => i.id), ['cide', 'pis', 'cofins']);
  assert.equal(calcOutros({ reais: 1, natureza: 'xyz' }), null);
});

test('ISS não entra por padrão (não se aplica ao caso); se informado, vale só para serviço', () => {
  const o = calcOutros({ reais: 17314.05, natureza: 'tecnico' });
  assert.equal(o.itens.some((i) => i.id === 'iss'), false);
  assert.equal(o.total, 3332.96);
  const c = calcOutros({ reais: 17314.05, natureza: 'tecnico', iss: 3 });
  assert.equal(c.itens.find((i) => i.id === 'iss').valor, 519.42);
  assert.equal(c.total, 3852.38);
  assert.equal(calcOutros({ reais: 1000, natureza: 'royalties', iss: 3 }).itens.some((i) => i.id === 'iss'), false);
});

test('alíquotas padrão dos outros tributos', () => {
  assert.equal(OUTROS.cide.pct, 10); assert.equal(OUTROS.pis.pct, 1.65); assert.equal(OUTROS.cofins.pct, 7.6); assert.equal(OUTROS.iss.pct, 0);
});
