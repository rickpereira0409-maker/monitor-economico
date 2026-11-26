import test from 'node:test';
import assert from 'node:assert/strict';
import { pctChange, windowChange, marketStatus, freshness, round } from '../src/lib/fx.js';
import { spParts, spLocalToDate, daysBetween, lastWeekday, addDays, bcbDate, fmtSP } from '../src/lib/time.js';

test('pctChange: variação percentual correta e casos inválidos', () => {
  assert.equal(round(pctChange(5.90, 5.80), 4), 1.7241);
  assert.equal(round(pctChange(5.80, 5.90), 4), -1.6949);
  assert.equal(pctChange(5, 5), 0);
  assert.equal(pctChange(5, 0), null);
  assert.equal(pctChange(null, 5), null);
  assert.equal(pctChange('abc', 5), null);
  assert.equal(pctChange(0.0037, 0.0036) > 0, true); // valores pequenos (ARS)
});

test('windowChange: usa o ponto mais antigo da janela e exige cobertura mínima', () => {
  const now = Date.parse('2026-11-25T15:00:00Z');
  const min = (m) => now - m * 60000;
  const series = [{ t: min(60), v: 5.80 }, { t: min(30), v: 5.85 }, { t: min(0), v: 5.90 }, { t: min(300), v: 1 }];
  const r = windowChange(series, 60 * 60000, now);
  assert.equal(r.from.v, 5.80);
  assert.equal(r.to.v, 5.90);
  assert.equal(round(r.pct, 3), 1.724);
  // pontos próximos demais não representam a janela
  assert.equal(windowChange([{ t: min(2), v: 5 }, { t: min(0), v: 6 }], 60 * 60000, now), null);
  assert.equal(windowChange([{ t: min(0), v: 6 }], 60 * 60000, now), null);
  assert.equal(windowChange([], 60000, now), null);
});

test('marketStatus: horário e dias úteis em Brasília', () => {
  // 25/11/2026 é quarta-feira. 12:00Z = 09:00 em Brasília (UTC-3)
  assert.equal(marketStatus(new Date('2026-11-25T12:00:00Z')).open, true);
  assert.equal(marketStatus(new Date('2026-11-25T11:59:00Z')).open, false); // 08:59
  assert.equal(marketStatus(new Date('2026-11-25T19:59:00Z')).open, true);  // 16:59
  assert.equal(marketStatus(new Date('2026-11-25T20:00:00Z')).open, false); // 17:00
  assert.equal(marketStatus(new Date('2026-11-28T15:00:00Z')).open, false); // sábado
  assert.match(marketStatus(new Date('2026-11-29T15:00:00Z')).reason, /Fim de semana/);
});

test('freshness: mercado aberto atrasa em 20 min; fechado só após 72 h; PTAX por dia útil', () => {
  const now = new Date('2026-11-25T15:00:00Z'); // 12:00 BRT, aberto
  assert.equal(freshness('2026-11-25T14:50:00Z', 'comercial', now).stale, false);
  const late = freshness('2026-11-25T14:30:00Z', 'comercial', now);
  assert.equal(late.stale, true);
  assert.match(late.note, /atrasados/);
  const sat = new Date('2026-11-28T15:00:00Z');
  assert.equal(freshness('2026-11-27T20:00:00Z', 'comercial', sat).stale, false);
  assert.equal(freshness('2026-11-26T20:00:00Z', 'comercial', sat).stale, false); // 67 h: ainda dentro de 72 h
  assert.equal(freshness('2026-11-24T20:00:00Z', 'comercial', sat).stale, true);  // 91 h
  // PTAX: segunda de manhã, a última PTAX de sexta é "atual"; de quinta não
  const mon = new Date('2026-11-30T13:00:00Z');
  assert.equal(freshness('2026-11-27T16:00:00Z', 'ptax', mon).stale, false);
  assert.equal(freshness('2026-11-26T16:00:00Z', 'ptax', mon).stale, true);
  // depois das 10h30 de segunda, a PTAX de sexta já é considerada atrasada
  assert.equal(freshness('2026-11-27T16:00:00Z', 'ptax', new Date('2026-11-30T14:00:00Z')).stale, true);
  assert.equal(freshness('2026-11-30T13:10:00Z', 'ptax', new Date('2026-11-30T14:00:00Z')).stale, false);
});

test('datas: fuso America/Sao_Paulo, BCB e dias úteis', () => {
  const p = spParts(new Date('2026-11-26T02:30:00Z')); // 25/11 23:30 em Brasília
  assert.equal(p.date, '2026-11-25');
  assert.equal(p.hour, 23);
  assert.equal(p.weekday, 3);
  assert.equal(spLocalToDate('2026-11-25 13:02:42.418138').toISOString(), '2026-11-25T16:02:42.000Z');
  assert.equal(spLocalToDate('lixo'), null);
  assert.equal(fmtSP(new Date('2026-11-25T16:02:00Z')), '25/11/2026 13:02');
  assert.equal(daysBetween('2026-11-25', '2026-12-02'), 7);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(lastWeekday('2026-11-29'), '2026-11-27'); // domingo -> sexta
  assert.equal(lastWeekday('2026-11-25'), '2026-11-25');
  assert.equal(bcbDate('2026-11-05'), '11-05-2026');
});
