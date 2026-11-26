import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseInvoice, detectCountry } from '../public/invoice.js';

// Textos de teste baseados nas invoices reais (sem CNPJ/contas).
const PARAGUAI = `INVOICE — EXIMIUS SOCIEDAD ANONIMA
Prf. Antonio Maidana esq. Tte. Bougermini – Asunción, Paraguay
Invoice N°: 001-001-00059
Data de emissão: 18/05/2026
TOMADOR
Razón Social: LAKE INDUSTRIA DE PRODUCTOS QUIMICOS S.A.
CONCEITO
Honorarios Profesionales por servicio de acompañamiento para análisis en minas y canteras.
Valor: USD 3.415,00
TOTAL: USD 3.415,00
DADOS PARA TRANSFERÊNCIA
Campo 56A (Banco intermediário):
  BANCO DE LA NACION ARGENTINA – NEW YORK BRANCH – USA
  SWIFT: NACNUS33
Campo 57A (Banco do beneficiário):
  BANCO DE LA NACION ARGENTINA – ASUNCIÓN, PARAGUAY
  SWIFT: NACNPYPA`;

const PANAMA = `PROFORMA INVOICE — INTERCONTINENTAL MIRAMAR PANAMA
RUC: 34573-11-2567667  DV.50
Proforma Invoice #: 96522
Data: terça-feira, 17/11/2026
CLIENTE
Lake Industria de Produtos Químicos - Rompex
PAYMENT DUE: USD 1,486.87
ITENS
| Qtd | Descrição | Valor estimado |
|-----|-----------|----------------|
| 1 | Payment for the Access Rompex event (November 21, 2026) | USD 408.87 |
| 3 | Payment for the room in Le Meridien (November 17, 2026) | USD 1,078.00 |
TOTAL: USD 1,486.87`;

test('parseAmount entende formatos brasileiro, americano e milhar', () => {
  assert.equal(parseAmount('3.415,00'), 3415);
  assert.equal(parseAmount('1,486.87'), 1486.87);
  assert.equal(parseAmount('USD 408.87'), 408.87);
  assert.equal(parseAmount('3415.00'), 3415);
  assert.equal(parseAmount('1.486'), 1486);
  assert.equal(parseAmount('12.345.678,90'), 12345678.9);
  assert.equal(parseAmount('1,078.00'), 1078);
  assert.equal(parseAmount('abc'), null);
});

test('invoice do Paraguai: serviço, USD 3.415, país pelo cabeçalho (não pelos bancos Argentina/EUA)', () => {
  const r = parseInvoice(PARAGUAI);
  assert.equal(r.valor, 3415); assert.equal(r.moeda, 'USD'); assert.equal(r.pais, 'Paraguai');
  assert.equal(r.paisFonte, 'cabeçalho (emissor)');
  assert.equal(r.natureza, 'servico'); assert.equal(r.numero, '001-001-00059'); assert.equal(r.data, '2026-05-18');
  assert.equal(r.avisos.some((a) => /PROFORMA/.test(a)), false);
  assert.equal(r.avisos.some((a) => /dados bancários/.test(a)), false, 'tem SWIFT');
});

test('invoice do Panamá: proforma, itens separados em viagem (hotel) e serviço (evento)', () => {
  const r = parseInvoice(PANAMA);
  assert.equal(r.valor, 1486.87); assert.equal(r.moeda, 'USD'); assert.equal(r.pais, 'Panamá');
  assert.equal(r.numero, '96522'); assert.equal(r.data, '2026-11-17');
  assert.equal(r.itens.length, 2);
  assert.deepEqual(r.valorPorNatureza, { servico: 408.87, viagem: 1078 });
  assert.equal(r.natureza, 'misto');
  assert.ok(r.avisos.some((a) => /PROFORMA/.test(a)));
  assert.ok(r.avisos.some((a) => /Não há dados bancários/.test(a)));
  assert.ok(r.avisos.some((a) => /Mistura naturezas/.test(a)));
  assert.equal(r.avisos.some((a) => /não bate/.test(a)), false);
});

test('detectCountry: cabeçalho vale mais que dados bancários', () => {
  assert.equal(detectCountry('Fornecedor Ltda\nSão Paulo\nBANCO X SWIFT: ABC - PANAMA').country, 'Panamá');
  assert.equal(detectCountry('Invoice\nCliente\nTotal\nSWIFT: X\nBank of Chile Santiago, Chile').country, 'Chile');
  assert.equal(detectCountry('nada aqui').country, null);
});

test('texto sem informações gera avisos em vez de inventar valores', () => {
  const r = parseInvoice('documento qualquer sem valores');
  assert.equal(r.valor, null);
  assert.ok(r.avisos.some((a) => /valor total/.test(a)));
  assert.ok(r.avisos.some((a) => /país/.test(a)));
});

test('aviso quando a soma dos itens não bate com o total', () => {
  const r = parseInvoice(`Invoice #: 1\nAcme Corp, United States\n| 1 | Software license | USD 100.00 |\n| 1 | Support service | USD 50.00 |\nTOTAL: USD 200.00`);
  assert.ok(r.avisos.some((a) => /não bate/.test(a)));
  assert.equal(r.pais, 'Estados Unidos');
});

test('texto extraído de PDF (linha quebrada, colunas separadas por espaços) também separa os itens', () => {
  const pdf = `PROFORMA INVOICE — INTERCONTINENTAL MIRAMAR PANAMA
RUC: 34573-11-2567667  DV.50
Proforma Invoice #: 96522
Data: terça-feira, 17/11/2026
CLIENTE
Lake Industria de Produtos Químicos - Rompex
PAYMENT DUE: USD 1,486.87
Qtd  Descrição  Valor estimado
Payment for the Access Rompex event (November 21,
1  USD 408.87
2026)
3  Payment for the room in Le Meridien (November 17, 2026) USD 1,078.00
TOTAL: USD 1,486.87`;
  const r = parseInvoice(pdf);
  assert.equal(r.valor, 1486.87); assert.equal(r.pais, 'Panamá');
  assert.equal(r.itens.length, 2);
  assert.deepEqual(r.valorPorNatureza, { servico: 408.87, viagem: 1078 });
  assert.equal(r.natureza, 'misto');
  assert.equal(r.avisos.some((a) => /não bate/.test(a)), false);
});
