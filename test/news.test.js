import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { normTitle, canonicalUrl, classifyChange, contentHash, analyzeNews, similarity } from '../src/analysis/news.js';
import { ingestNewsItem } from '../src/collectors/news.js';
import { parseFeed } from '../src/lib/xml.js';

const NOW = new Date('2026-11-25T15:00:00Z');
const feed = { id: 'f1', name: 'Agência X', official: false, region: 'BR' };
const item = (o = {}) => ({ id: 'g1', title: 'Copom eleva a Selic em 0,25 ponto percentual', link: 'https://x.com/a?utm_source=tw', summary: 'O Comitê de Política Monetária elevou a taxa básica de juros.', published: '2026-11-25T14:00:00Z', publisher: null, ...o });

test('normTitle e canonicalUrl removem ruído', () => {
  assert.equal(normTitle('Dólar sobe, Selic em alta! - InfoMoney', 'InfoMoney'), 'dolar sobe selic em alta');
  assert.equal(canonicalUrl('https://Site.com/a/?utm_source=x&id=2#topo'), 'https://site.com/a/?id=2');
  assert.ok(similarity('copom eleva a selic', 'copom eleva a selic hoje') > 0.7);
});

test('classifyChange: republicação, ajuste menor e atualização real', () => {
  const prev = { title: 'Copom eleva a Selic em 0,25 ponto', summary: 'O Banco Central elevou a taxa básica de juros nesta quarta.', content_hash: contentHash('Copom eleva a Selic em 0,25 ponto', 'O Banco Central elevou a taxa básica de juros nesta quarta.') };
  assert.equal(classifyChange(prev, { title: 'Copom eleva a Selic em 0,25 ponto', summary: 'O Banco Central elevou a taxa básica de juros nesta quarta.' }), 'republicacao');
  assert.equal(classifyChange(prev, { title: 'Copom eleva a Selic em 0,25 ponto', summary: 'O Banco Central elevou a taxa básica de juros nesta quarta-feira.' }), 'ajuste_menor');
  assert.equal(classifyChange(prev, { title: 'Copom surpreende e mantém a Selic; mercado reage', summary: 'Decisão divergiu das expectativas e o dólar disparou.' }), 'atualizacao');
});

test('ingestNewsItem: nova -> republicação ignorada -> atualização gera novo evento', () => {
  const db = openDb(':memory:');
  assert.equal(ingestNewsItem(db, feed, item(), NOW), 'nova');
  let ev = db.prepare('SELECT * FROM events').all();
  assert.equal(ev.length, 1); assert.equal(ev[0].type, 'news_new');

  // mesma notícia republicada (só mudou a data de publicação e a URL ganhou parâmetro de rastreio)
  assert.equal(ingestNewsItem(db, feed, item({ published: '2026-11-25T14:45:00Z', link: 'https://x.com/a?utm_source=fb' }), new Date(NOW.getTime() + 3600e3)), 'republicacao');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM news').get().n, 1);

  // atualização real: título e resumo mudam
  const upd = item({ title: 'Copom surpreende e mantém a Selic; dólar dispara', summary: 'Decisão contrariou as expectativas do mercado financeiro e o dólar disparou frente ao real.' });
  assert.equal(ingestNewsItem(db, feed, upd, new Date(NOW.getTime() + 7200e3)), 'atualizacao');
  ev = db.prepare('SELECT type FROM events ORDER BY id').all().map((e) => e.type);
  assert.deepEqual(ev, ['news_new', 'news_update']);
  const row = db.prepare('SELECT revision, title FROM news').get();
  assert.equal(row.revision, 2);
  assert.match(row.title, /mantém a Selic/);
});

test('ingestNewsItem: mesma matéria em outra fonte é duplicada e não gera evento; irrelevante e antiga são descartadas', () => {
  const db = openDb(':memory:');
  assert.equal(ingestNewsItem(db, feed, item(), NOW), 'nova');
  const other = { id: 'f2', name: 'Outro Veículo', region: 'BR' };
  assert.equal(ingestNewsItem(db, other, item({ id: 'zz', link: 'https://outro.com/b' }), NOW), 'duplicada');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'news_new'").get().n, 1);
  assert.equal(ingestNewsItem(db, feed, item({ id: 'q', title: 'Time vence campeonato regional', summary: 'Jogo foi emocionante', link: 'https://x.com/q' }), NOW), 'irrelevante');
  assert.equal(ingestNewsItem(db, feed, item({ id: 'old', link: 'https://x.com/old', title: 'Copom eleva a Selic hoje cedo', published: '2026-10-01T10:00:00Z' }), NOW), 'antiga');
  assert.equal(ingestNewsItem(db, feed, item({ id: 'fut', link: 'https://x.com/fut', title: 'Selic projetada para o futuro distante', published: '2026-12-25T10:00:00Z' }), NOW), 'irrelevante');
});

test('notícia antiga não gera evento de alerta, mas é guardada se recente o suficiente', () => {
  const db = openDb(':memory:');
  assert.equal(ingestNewsItem(db, feed, item({ published: '2026-11-20T10:00:00Z' }), NOW), 'nova');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
});

test('analyzeNews: direção só quando a frase é clara; sinais opostos viram incerto', () => {
  const a = (title, summary = '') => analyzeNews({ title, summary, source: 'T', url: 'u', official: false }, NOW);
  assert.equal(a('Copom eleva a Selic para 15%').direction, 'baixa');
  assert.equal(a('Copom corta a Selic em 0,50 ponto').direction, 'alta');
  assert.equal(a('Copom mantém a Selic').direction, 'incerto');
  assert.equal(a('Fed eleva juros nos EUA e fortalece o dólar').direction, 'alta');
  assert.equal(a('Fed corta juros nos EUA').direction, 'baixa');
  assert.equal(a('Governo anuncia déficit fiscal maior que o previsto').direction, 'alta');
  assert.equal(a('Governo apresenta superávit primário no mês').direction, 'baixa');
  assert.equal(a('Petróleo Brent dispara com tensão no Oriente Médio').topics.includes('commodities'), true);
  const mixed = a('Copom eleva a Selic enquanto governo amplia déficit fiscal');
  assert.equal(mixed.direction, 'incerto');
  assert.match(mixed.analysis.interpretacao.nota, /opostos/);
  // tema tributário: sem efeito cambial direto
  const t = a('Receita Federal divulga regras do IBS e da CBS');
  assert.equal(t.direction, 'incerto');
  assert.match(t.analysis.interpretacao.nota, /sem efeito cambial direto/);
  // falsos positivos conhecidos
  assert.equal(a('Brasil tem déficit de 110 mil cisternas e banheiros', 'Censo mostra desigualdade'), null);
  assert.equal(a('Tarifa de ônibus sobe 5% em São Paulo'), null);
  assert.equal(a('Time vence o campeonato'), null);
});

test('analyzeNews: separa fatos de interpretação, nunca promete previsão e relevância é limitada', () => {
  const r = analyzeNews({ title: 'Copom eleva a Selic', summary: 'Decisão unânime', source: 'Banco Central', url: 'https://bcb.gov.br/x', publishedAt: '2026-11-25T14:00:00Z', official: true }, NOW);
  assert.equal(r.analysis.fatos.fonte, 'Banco Central');
  assert.equal(r.analysis.fatos.link, 'https://bcb.gov.br/x');
  assert.match(r.analysis.interpretacao.aviso, /não é previsão/i);
  assert.match(r.analysis.interpretacao.aviso, /vários fatores/i);
  assert.ok(r.relevance <= 100 && r.relevance >= 0);
  assert.equal(r.level, 'alta');
  assert.notEqual(r.analysis.interpretacao.confianca, 'alta');
});

test('parseFeed: RSS, Atom, CDATA e HTML escapado', () => {
  const rss = `<rss><channel><item><title><![CDATA[Dólar &amp; juros]]></title><link>https://a.com/1</link><description>&lt;p&gt;Texto &lt;b&gt;forte&lt;/b&gt;&lt;/p&gt;</description><pubDate>Tue, 25 Nov 2026 14:00:00 GMT</pubDate><guid>abc</guid><source url="https://v.com">Veículo</source></item></channel></rss>`;
  const [a] = parseFeed(rss);
  assert.equal(a.title, 'Dólar & juros'); assert.equal(a.summary, 'Texto forte'); assert.equal(a.published, '2026-11-25T14:00:00.000Z'); assert.equal(a.publisher, 'Veículo'); assert.equal(a.id, 'abc');
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>e1</id><title type="text">BC faz anúncio</title><updated>2026-11-24T11:06:14-03:00</updated><link rel="alternate" href="https://bcb.gov.br/n/1"/><content type="html">&lt;p&gt;corpo&lt;/p&gt;</content></entry></feed>`;
  const [b] = parseFeed(atom);
  assert.equal(b.link, 'https://bcb.gov.br/n/1'); assert.equal(b.summary, 'corpo'); assert.equal(b.published, '2026-11-24T14:06:14.000Z');
  assert.deepEqual(parseFeed('<rss><channel></channel></rss>'), []);
});
