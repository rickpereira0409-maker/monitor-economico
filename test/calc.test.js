import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, simulateReceipt, checkConfirmation, PRESETS } from '../public/calc.js';

test('simulate reproduz a confirmação real da XP (18/11/2026)', () => {
  const r = simulate({ amount: 1486.87, rate: 5.810885, iofPct: 3.5, irPct: 8, grossUp: true });
  assert.equal(r.reais, 8640.03);
  assert.equal(r.iof, 302.4);
  assert.equal(r.irBase, 9391.34);
  assert.equal(r.ir, 751.31);
  assert.equal(r.total, 9693.74);
  assert.equal(r.vetSemIr.toFixed(5), '6.01426', 'VET impresso pelo banco (sem IR)');
  assert.equal(r.vetComIr.toFixed(4), '6.5196');
  assert.ok(r.acimaDaTaxaPct > 12 && r.acimaDaTaxaPct < 12.3);
});

test('simulate: sem gross-up o IR incide direto sobre o valor em reais; sem IR/IOF só cobra tarifa', () => {
  const r = simulate({ amount: 1000, rate: 5, iofPct: 3.5, irPct: 15, grossUp: false });
  assert.equal(r.ir, 750); assert.equal(r.iof, 175); assert.equal(r.total, 5925);
  const g = simulate({ amount: 1000, rate: 5, irPct: 15, grossUp: true });
  assert.equal(g.irBase, 5882.35); assert.equal(g.ir, 882.35);
  const z = simulate({ amount: 100, rate: 5, fee: 25 });
  assert.equal(z.total, 525); assert.equal(z.ir, 0);
});

test('R$ 748,53 de IR corresponde a 8% com gross-up sobre ~R$ 8.608 (o caso da segunda operação)', () => {
  const r = simulate({ amount: 1500, rate: 8608.1 / 1500, irPct: 8, grossUp: true });
  assert.equal(r.reais, 8608.1);
  assert.equal(r.ir, 748.53);
});

test('checkConfirmation: confirmação correta da XP só gera aviso sobre o VET', () => {
  const c = checkConfirmation({ amount: 1486.87, rate: 5.810885, reais: 8640.03, iof: 302.4, ir: 751.31, iofPct: 3.5, irPct: 8, grossUp: true });
  assert.equal(c.achados.some((a) => a.nivel === 'erro'), false);
  assert.ok(c.achados.some((a) => a.nivel === 'ok'));
  assert.ok(c.achados.some((a) => a.nivel === 'aviso' && /VET/.test(a.texto) && /6,5196|6\.5196/.test(a.texto)));
});

test('checkConfirmation: detecta IR não retido, IOF errado e valor em reais inconsistente', () => {
  const semIr = checkConfirmation({ amount: 1500, rate: 8608.1 / 1500, reais: 8608.1, iof: 301.28, ir: 0, iofPct: 3.5, irPct: 8, grossUp: true });
  const e = semIr.achados.find((a) => a.nivel === 'erro');
  assert.match(e.texto, /IR NÃO foi cobrado/);
  assert.match(e.texto, /748,53/);
  const iofErrado = checkConfirmation({ amount: 1000, rate: 5, reais: 5000, iof: 19, ir: 0, iofPct: 3.5, irPct: 0 });
  assert.match(iofErrado.achados.find((a) => a.nivel === 'erro').texto, /IOF cobrado/);
  const iofAusente = checkConfirmation({ amount: 1000, rate: 5, reais: 5000, iof: 0, ir: 0, iofPct: 3.5, irPct: 0 });
  assert.match(iofAusente.achados.find((a) => a.nivel === 'erro').texto, /IOF não aparece/);
  const reais = checkConfirmation({ amount: 1000, rate: 5, reais: 4900, iof: 0, ir: 0, iofPct: 0, irPct: 0 });
  assert.ok(reais.achados.some((a) => a.nivel === 'aviso' && /não bate/.test(a.texto)));
  const irDifere = checkConfirmation({ amount: 1000, rate: 5, reais: 5000, iof: 0, ir: 100, iofPct: 0, irPct: 8, grossUp: true });
  assert.match(irDifere.achados.find((a) => a.nivel === 'erro').texto, /IR cobrado/);
});

test('simulateReceipt: exportação não paga IOF; só desconta tarifa', () => {
  const r = simulateReceipt({ amount: 10000, rate: 5.8, fee: 80 });
  assert.equal(r.reais, 58000); assert.equal(r.iof, 0); assert.equal(r.liquido, 57920);
  assert.equal(r.taxaEfetiva.toFixed(4), '5.7920');
});

test('predefinições declaram o grau de confiança de cada alíquota', () => {
  assert.ok(PRESETS.every((p) => ['observado', 'confirmado', 'a confirmar'].includes(p.status)));
  assert.equal(PRESETS.find((p) => p.id === 'exportacao').iofPct, 0);
  assert.equal(PRESETS.find((p) => p.id === 'servico-geral').status, 'observado');
});

test('simulate reproduz a cotação do Banco Rendimento (serviço ao Paraguai, taxa 5,07)', () => {
  const r = simulate({ amount: 3415, rate: 5.07, iofPct: 3.5, irPct: 15, grossUp: true, fee: 150.9 });
  assert.equal(r.reais, 17314.05);
  assert.equal(r.iof, 605.99);
  assert.equal(r.ir, 3055.42, 'DARF 0422: 15% com gross-up = 17,647% sobre o líquido');
  assert.equal(r.total, 21126.36, 'VALOR FINAL da cotação');
  assert.equal(((r.reais + r.iof + 150.9) / 3415).toFixed(4), '5.2916', 'VET impresso (sem IR)');
  assert.equal((15 / 85 * 100).toFixed(7), '17.6470588');
});
