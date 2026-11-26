import { FEEDS } from '../config/sources.js';
import { fetchRetry } from '../lib/http.js';
import { parseFeed } from '../lib/xml.js';
import { analyzeNews, classifyChange, contentHash, newsKey, normTitle } from '../analysis/news.js';

const MAX_AGE_DAYS = 14;      // não guarda notícias mais velhas que isso
const ALERT_WINDOW_H = 48;    // só gera evento de alerta para notícias publicadas nesse prazo

const cleanTitle = (title, publisher) => (publisher ? title.replace(new RegExp(`\\s[-–|]\\s${publisher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '') : title);

/**
 * Processa um item de feed. Retorna: 'nova' | 'duplicada' | 'republicacao' | 'ajuste_menor' | 'atualizacao' | 'irrelevante' | 'antiga'.
 */
export function ingestNewsItem(db, feed, item, now = new Date()) {
  const publisher = item.publisher;
  const title = cleanTitle(item.title, publisher);
  const source = feed.aggregator ? (publisher || feed.name) : feed.name;
  const published = item.published;
  if (published && now - new Date(published) > MAX_AGE_DAYS * 86400e3) return 'antiga';
  if (published && new Date(published) - now > 36 * 3600e3) return 'irrelevante'; // data no futuro: feed com erro

  const analysis = analyzeNews({ title, summary: item.summary, source, url: item.link, publishedAt: published, official: !!feed.official, region: feed.region }, now, feed.forceTopic);
  if (!analysis) return 'irrelevante';

  const key = newsKey(feed.id, item);
  const nowIso = now.toISOString();
  const existing = db.prepare('SELECT * FROM news WHERE key = ?').get(key);
  const row = {
    title, summary: item.summary || null, hash: contentHash(title, item.summary),
    topics: JSON.stringify(analysis.topics), analysis: JSON.stringify(analysis.analysis),
  };

  if (existing) {
    const kind = classifyChange(existing, { title, summary: item.summary });
    if (kind === 'atualizacao') {
      db.prepare(`UPDATE news SET title=?, summary=?, content_hash=?, revision=revision+1, last_change=?, last_seen_at=?, relevance=?, level=?, direction=?, topics=?, analysis=? WHERE id=?`)
        .run(row.title, row.summary, row.hash, nowIso, nowIso, analysis.relevance, analysis.level, analysis.direction, row.topics, row.analysis, existing.id);
      db.prepare('INSERT INTO events (type, ref, payload, created_at) VALUES (?, ?, ?, ?)').run('news_update', String(existing.id), JSON.stringify({ revision: existing.revision + 1 }), nowIso);
    } else {
      db.prepare('UPDATE news SET last_seen_at = ? WHERE id = ?').run(nowIso, existing.id); // republicação/ajuste: sem evento
    }
    return kind;
  }

  const norm = normTitle(title, publisher);
  const since = new Date(now.getTime() - 3 * 86400e3).toISOString();
  const dup = db.prepare('SELECT id FROM news WHERE norm_title = ? AND first_seen_at > ? AND duplicate_of IS NULL LIMIT 1').get(norm, since);
  const info = db.prepare(`INSERT INTO news (key, norm_title, url, source, feed, official, title, summary, published_at, first_seen_at, last_seen_at, content_hash, duplicate_of, relevance, level, direction, topics, analysis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(key, norm, item.link, source, feed.id, feed.official ? 1 : 0, title, row.summary, published, nowIso, nowIso, row.hash, dup?.id ?? null, analysis.relevance, analysis.level, analysis.direction, row.topics, row.analysis);
  if (dup) return 'duplicada';
  const recent = !published || now - new Date(published) < ALERT_WINDOW_H * 3600e3;
  if (recent) db.prepare('INSERT INTO events (type, ref, payload, created_at) VALUES (?, ?, ?, ?)').run('news_new', String(info.lastInsertRowid), null, nowIso);
  return 'nova';
}

/** Coleta todos os feeds. Falha de um feed não interrompe os demais; lança erro só se TODOS falharem. */
export async function collectNews(db, now = new Date(), { feeds = FEEDS, fetcher = fetchRetry } = {}) {
  const results = [];
  for (const feed of feeds) {
    const r = { id: feed.id, name: feed.name, ok: true, items: 0, nova: 0, atualizacao: 0, error: null };
    try {
      const xml = await fetcher(feed.url, { retries: 2, timeoutMs: 20000 });
      const items = parseFeed(xml).slice(0, 60);
      r.items = items.length;
      if (!items.length) throw new Error('feed sem itens legíveis');
      for (const it of items) {
        const kind = ingestNewsItem(db, feed, it, now);
        if (kind === 'nova') r.nova++;
        if (kind === 'atualizacao') r.atualizacao++;
      }
    } catch (e) { r.ok = false; r.error = e.message; }
    results.push(r);
  }
  if (results.every((r) => !r.ok)) throw new Error(`Todos os feeds falharam. Exemplo: ${results[0].error}`);
  return { feeds: results };
}
