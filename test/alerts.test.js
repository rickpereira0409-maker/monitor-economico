import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setPrefs, getPrefs } from '../src/db.js';
import {
  evalPriceRule, inDeliveryWindow, cooldownOk, newsMatchesRule, createAlert, addRule, evaluateFxRules, evaluateDeadlines,
  evaluateDigests, processEvents, weekKey, ensureDefaultRules,
} from '../src/alerts/engine.js';
import { flushOutbox, formatMessage } from '../src/alerts/channels.js';

const NOW = new Date('2026-11-25T15:00:00Z'); // quarta, 12:00 em Brasília
const mk = () => { const db = openDb(':memory:'); return db; };
const quote = (db, code, type, value, iso) => db.prepare("INSERT INTO fx_quotes (code, rate_type, source, value, quote_ts, fetched_at) VALUES (?, ?, 'teste', ?, ?, ?)").run(code, type, value, iso, iso);
const alerts = (db) => db.prepare('SELECT * FROM alerts ORDER BY id').all();

test('evalPriceRule: dispara uma vez ao cruzar e só rearma depois de voltar', () => {
  let st = true, r;
  r = evalPriceRule('price_above', 6, 5.9, st); assert.deepEqual(r, { fire: false, armed: true });
  r = evalPriceRule('price_above', 6, 6.01, st); assert.deepEqual(r, { fire: true, armed: false }); st = r.armed;
  r = evalPriceRule('price_above', 6, 6.05, st); assert.deepEqual(r, { fire: false, armed: false }); // continua acima: não repete
  r = evalPriceRule('price_above', 6, 5.99, st); assert.deepEqual(r, { fire: false, armed: true }); st = r.armed;
  r = evalPriceRule('price_above', 6, 6.2, st); assert.equal(r.fire, true);
  assert.equal(evalPriceRule('price_below', 5.5, 5.5, true).fire, true); // limite exato conta
  assert.equal(evalPriceRule('price_below', 5.5, 5.51, true).fire, false);
});

test('inDeliveryWindow: janela normal, que cruza a meia-noite e só dias úteis', () => {
  const at = (iso) => new Date(iso);
  const d = { startHour: 8, endHour: 20, weekdaysOnly: false };
  assert.equal(inDeliveryWindow(d, at('2026-11-25T11:00:00Z')), true);  // 08:00
  assert.equal(inDeliveryWindow(d, at('2026-11-25T10:59:00Z')), false); // 07:59
  assert.equal(inDeliveryWindow(d, at('2026-11-25T23:00:00Z')), false); // 20:00
  const night = { startHour: 22, endHour: 6, weekdaysOnly: false };
  assert.equal(inDeliveryWindow(night, at('2026-11-26T01:30:00Z')), true);  // 22:30
  assert.equal(inDeliveryWindow(night, at('2026-11-25T15:00:00Z')), false); // 12:00
  assert.equal(inDeliveryWindow({ ...d, weekdaysOnly: true }, at('2026-11-28T15:00:00Z')), false); // sábado
  assert.equal(inDeliveryWindow({ startHour: 8, endHour: 8 }, at('2026-11-25T05:00:00Z')), true);
});

test('cooldownOk e newsMatchesRule', () => {
  assert.equal(cooldownOk(null, 60, NOW), true);
  assert.equal(cooldownOk('2026-11-25T14:30:00Z', 60, NOW), false);
  assert.equal(cooldownOk('2026-11-25T13:59:00Z', 60, NOW), true);
  const n = { level: 'media', topics: '["juros_br"]', direction: 'baixa' };
  assert.equal(newsMatchesRule(n, { minLevel: 'alta' }), false);
  assert.equal(newsMatchesRule(n, { minLevel: 'media' }), true);
  assert.equal(newsMatchesRule(n, { minLevel: 'media', topics: ['fiscal'] }), false);
  assert.equal(newsMatchesRule(n, { minLevel: 'media', topics: ['juros_br'], directions: ['alta'] }), false);
});

test('createAlert: chave de deduplicação impede alerta repetido', () => {
  const db = mk();
  const base = { kind: 'noticia', dedupeKey: 'k1', title: 'a', now: NOW };
  assert.ok(createAlert(db, base));
  assert.equal(createAlert(db, base), null);
  assert.ok(createAlert(db, { ...base, dedupeKey: 'k2' }));
  assert.equal(alerts(db).length, 2);
});

test('evaluateFxRules: preço cruza, não repete, rearma e respeita cotação velha', () => {
  const db = mk();
  const id = addRule(db, { type: 'price_above', name: 'USD>5,90', params: { code: 'USD', rate_type: 'comercial', value: 5.9 }, channels: ['inapp'], cooldown_min: 0 });
  const t = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
  quote(db, 'USD', 'comercial', 5.85, t(10));
  assert.equal(evaluateFxRules(db, NOW), 0);
  quote(db, 'USD', 'comercial', 5.92, t(5));
  assert.equal(evaluateFxRules(db, NOW), 1);
  quote(db, 'USD', 'comercial', 5.95, t(3));
  assert.equal(evaluateFxRules(db, NOW), 0, 'continua acima: sem repetição');
  quote(db, 'USD', 'comercial', 5.80, t(2));
  assert.equal(evaluateFxRules(db, NOW), 0);
  quote(db, 'USD', 'comercial', 5.93, t(1));
  assert.equal(evaluateFxRules(db, NOW), 1, 'rearmou ao voltar abaixo');
  assert.equal(alerts(db).length, 2);
  assert.match(alerts(db)[0].title, /acima de R\$ 5,9000/);
  assert.ok(id);

  // cotação velha não dispara
  const db2 = mk();
  addRule(db2, { type: 'price_above', name: 'x', params: { code: 'USD', rate_type: 'comercial', value: 5 }, channels: ['inapp'], cooldown_min: 0 });
  quote(db2, 'USD', 'comercial', 6, new Date(NOW.getTime() - 8 * 3600e3).toISOString());
  assert.equal(evaluateFxRules(db2, NOW), 0);
});

test('evaluateFxRules: tipos de cotação não se misturam (PTAX não dispara regra de comercial)', () => {
  const db = mk();
  addRule(db, { type: 'price_above', name: 'x', params: { code: 'USD', rate_type: 'comercial', value: 5.9 }, channels: ['inapp'], cooldown_min: 0 });
  quote(db, 'USD', 'ptax', 6.5, new Date(NOW.getTime() - 60000).toISOString());
  quote(db, 'USD', 'comercial', 5.8, new Date(NOW.getTime() - 60000).toISOString());
  assert.equal(evaluateFxRules(db, NOW), 0);
});

test('evaluateFxRules: variação percentual em janela, com intervalo mínimo', () => {
  const db = mk();
  addRule(db, { type: 'pct_move', name: '±1%/1h', params: { code: 'USD', rate_type: 'comercial', pct: 1, windowMin: 60 }, channels: ['inapp'], cooldown_min: 120 });
  const t = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
  quote(db, 'USD', 'comercial', 5.80, t(58)); quote(db, 'USD', 'comercial', 5.81, t(30)); quote(db, 'USD', 'comercial', 5.82, t(1));
  assert.equal(evaluateFxRules(db, NOW), 0, '0,34% em 1 h: abaixo do limite de 1%');
  quote(db, 'USD', 'comercial', 5.89, t(0.5));
  assert.equal(evaluateFxRules(db, NOW), 1, '1,55% em ~1 h dispara');
  assert.match(alerts(db)[0].title, /alta de \+1,55% em 60 min/);
  const later = new Date(NOW.getTime() + 2 * 60000);
  quote(db, 'USD', 'comercial', 5.95, new Date(NOW.getTime() + 60000).toISOString());
  assert.equal(evaluateFxRules(db, later), 0, 'dentro do intervalo mínimo de 120 min: não repete');
  assert.equal(alerts(db).length, 1);
});

test('evaluateDeadlines: lembretes 7/3/1/0 dias, sem duplicar, ignora passados', () => {
  const db = mk(); ensureDefaultRules(db, NOW);
  const add = (title, date) => db.prepare("INSERT INTO deadlines (title, date, origin) VALUES (?, ?, 'usuario')").run(title, date);
  add('em 7', '2026-12-02'); add('em 3', '2026-11-28'); add('amanhã', '2026-11-26'); add('hoje', '2026-11-25'); add('em 5', '2026-11-30'); add('ontem', '2026-11-24');
  assert.equal(evaluateDeadlines(db, NOW), 4);
  assert.equal(evaluateDeadlines(db, NOW), 0, 'rodar de novo não duplica');
  const titles = alerts(db).map((a) => a.title).join(' | ');
  assert.match(titles, /é em 7 dias: em 7/); assert.match(titles, /é HOJE: hoje/); assert.match(titles, /é amanhã/);
  assert.doesNotMatch(titles, /em 5|ontem/);
  // no dia seguinte, o prazo de "em 5" passa a faltar 4 dias: nenhum lembrete; "em 3" passa a 2: nenhum
  assert.equal(evaluateDeadlines(db, new Date(NOW.getTime() + 86400e3)), 1); // 'em 7' -> faltam 6? não; 'em 3'->2? não; 'amanhã'->hoje sim
});

test('processEvents: notícia relevante gera um único alerta por versão; atualização gera novo', () => {
  const db = mk(); ensureDefaultRules(db, NOW);
  const info = db.prepare(`INSERT INTO news (key, norm_title, url, source, title, first_seen_at, last_seen_at, content_hash, level, direction, topics, relevance, published_at)
    VALUES ('k', 't', 'https://x.com', 'Fonte', 'Selic sobe', ?, ?, 'h', 'alta', 'baixa', '["juros_br"]', 80, ?)`).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  const id = String(info.lastInsertRowid);
  db.prepare("INSERT INTO events (type, ref, created_at) VALUES ('news_new', ?, ?)").run(id, NOW.toISOString());
  db.prepare("INSERT INTO events (type, ref, created_at) VALUES ('news_new', ?, ?)").run(id, NOW.toISOString()); // evento duplicado
  assert.equal(processEvents(db, NOW), 1);
  assert.equal(alerts(db).length, 1);
  assert.match(alerts(db)[0].body, /não é previsão/);
  db.prepare('UPDATE news SET revision = 2 WHERE id = ?').run(id);
  db.prepare("INSERT INTO events (type, ref, created_at) VALUES ('news_update', ?, ?)").run(id, NOW.toISOString());
  assert.equal(processEvents(db, NOW), 1);
  assert.match(alerts(db)[1].title, /^Atualização:/);
  // baixa relevância não alerta
  const i2 = db.prepare(`INSERT INTO news (key, norm_title, url, source, title, first_seen_at, last_seen_at, content_hash, level, direction, topics) VALUES ('k2','t2','https://y.com','F','Algo',?,?,'h2','baixa','incerto','[]')`).run(NOW.toISOString(), NOW.toISOString());
  db.prepare("INSERT INTO events (type, ref, created_at) VALUES ('news_new', ?, ?)").run(String(i2.lastInsertRowid), NOW.toISOString());
  assert.equal(processEvents(db, NOW), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events WHERE processed = 0').get().n, 0);
});

test('resumo diário: uma vez por dia, só depois da hora configurada; semanal na segunda', () => {
  const db = mk();
  const early = new Date('2026-11-25T10:00:00Z'); // 07:00 BRT
  assert.equal(evaluateDigests(db, early), 0);
  assert.equal(evaluateDigests(db, NOW), 1);   // quarta 12:00: diário sim, semanal não (segunda)
  assert.equal(evaluateDigests(db, NOW), 0);
  assert.equal(evaluateDigests(db, new Date(NOW.getTime() + 3600e3)), 0);
  assert.equal(evaluateDigests(db, new Date('2026-11-30T13:00:00Z')), 2); // segunda 10:00: diário + semanal
  assert.equal(weekKey(new Date('2026-11-29T20:00:00Z')), '2026-11-23'); // domingo pertence à semana de segunda 23
  assert.match(alerts(db)[0].body, /MOEDAS/);
  assert.match(alerts(db)[0].title, /Resumo diário — 25\/11\/2026/);
});

// ----- fila de envio -----
function setup(prefsPatch = {}) {
  const db = mk();
  setPrefs(db, { channels: { email: { enabled: true, to: 'a@b.com' }, telegram: { enabled: false, chatId: '' } }, ...prefsPatch });
  return db;
}
const fakeSender = () => { const calls = []; return { calls, send: async (ch, msg) => { calls.push({ ch, msg }); } }; };
const AV = { email: true, telegram: true };

test('flushOutbox: agrupa alertas, respeita intervalo mínimo e janela de horário', async () => {
  const db = setup();
  for (let i = 0; i < 3; i++) createAlert(db, { kind: 'noticia', dedupeKey: `n${i}`, title: `Alerta ${i}`, channels: ['inapp', 'email'], now: NOW });
  const s = fakeSender();
  let r = await flushOutbox(db, NOW, s, AV);
  assert.equal(s.calls.length, 1, 'três alertas em uma única mensagem');
  assert.equal(r.sent, 3);
  assert.match(s.calls[0].msg.subject, /3 novos alertas/);

  createAlert(db, { kind: 'noticia', dedupeKey: 'n9', title: 'Novo', channels: ['email'], now: NOW });
  r = await flushOutbox(db, new Date(NOW.getTime() + 10 * 60000), s, AV); // 10 min < 30 min de intervalo
  assert.equal(r.sent, 0); assert.equal(r.held, 1);
  r = await flushOutbox(db, new Date(NOW.getTime() + 31 * 60000), s, AV);
  assert.equal(r.sent, 1);

  // fora da janela (22:00 BRT), mantém na fila
  createAlert(db, { kind: 'noticia', dedupeKey: 'n10', title: 'Noite', channels: ['email'], now: NOW });
  const night = new Date('2026-11-26T01:00:00Z');
  r = await flushOutbox(db, night, s, AV);
  assert.equal(r.sent, 0); assert.equal(r.held, 1);
  r = await flushOutbox(db, new Date('2026-11-26T11:30:00Z'), s, AV); // 08:30 do dia seguinte
  assert.equal(r.sent, 1);
});

test('flushOutbox: resumo sai sozinho e ignora o intervalo mínimo', async () => {
  const db = setup();
  createAlert(db, { kind: 'noticia', dedupeKey: 'a', title: 'A', channels: ['email'], now: NOW });
  createAlert(db, { kind: 'resumo', dedupeKey: 'd', title: 'Resumo', body: 'x', channels: ['email'], now: NOW });
  const s = fakeSender();
  await flushOutbox(db, NOW, s, AV);
  assert.equal(s.calls.length, 2);
  createAlert(db, { kind: 'resumo', dedupeKey: 'd2', title: 'Resumo 2', body: 'y', channels: ['email'], now: NOW });
  await flushOutbox(db, new Date(NOW.getTime() + 60000), s, AV);
  assert.equal(s.calls.length, 3);
});

test('flushOutbox: falha gera retentativa com espera crescente e desiste após 5 tentativas', async () => {
  const db = setup({ delivery: { minIntervalMin: 0 } });
  createAlert(db, { kind: 'noticia', dedupeKey: 'a', title: 'A', channels: ['email'], now: NOW });
  const bad = { send: async () => { throw new Error('SMTP fora do ar'); } };
  let t = NOW;
  const row = () => db.prepare('SELECT * FROM outbox').get();
  await flushOutbox(db, t, bad, AV);
  assert.equal(row().attempts, 1); assert.equal(row().status, 'pending'); assert.match(row().error, /SMTP/);
  const first = new Date(row().next_attempt_at) - t;
  assert.equal(first, 2 * 60000);
  const r = await flushOutbox(db, new Date(t.getTime() + 60000), bad, AV);
  assert.equal(r.failed, 0, 'ainda não chegou a hora da retentativa');
  for (let i = 0; i < 4; i++) { t = new Date(new Date(row().next_attempt_at).getTime() + 1000); await flushOutbox(db, t, bad, AV); }
  assert.equal(row().status, 'failed'); assert.equal(row().attempts, 5);
  const ok = fakeSender();
  await flushOutbox(db, new Date(t.getTime() + 86400e3), ok, AV);
  assert.equal(ok.calls.length, 0, 'não reenvia o que já falhou definitivamente');
});

test('flushOutbox: canal sem credenciais ou desativado não envia nem trava a fila', async () => {
  const db = setup();
  createAlert(db, { kind: 'noticia', dedupeKey: 'a', title: 'A', channels: ['email'], now: NOW });
  const s = fakeSender();
  await flushOutbox(db, NOW, s, { email: false, telegram: false });
  assert.equal(s.calls.length, 0);
  assert.equal(db.prepare('SELECT status FROM outbox').get().status, 'skipped');
  assert.equal(getPrefs(db).channels.telegram.enabled, false);
  // canal desativado nas preferências nem entra na fila
  createAlert(db, { kind: 'noticia', dedupeKey: 'b', title: 'B', channels: ['telegram'], now: NOW });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM outbox WHERE channel = 'telegram'").get().n, 0);
});

test('formatMessage: um alerta usa o título como assunto', () => {
  const m = formatMessage([{ title: 'USD/BRL acima de R$ 5,90', body: 'detalhe', link: 'https://x.com' }]);
  assert.equal(m.subject, '[Monitor] USD/BRL acima de R$ 5,90');
  assert.match(m.text, /https:\/\/x\.com/);
});
