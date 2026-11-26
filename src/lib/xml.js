// Leitor mínimo de RSS 2.0 / Atom, sem dependências. Suficiente para os feeds usados; não é um parser XML geral.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

export function stripHtml(s) {
  const noCdata = String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Decodifica antes e depois de remover tags: feeds costumam trazer HTML escapado (&lt;p&gt;).
  const once = decodeEntities(noCdata).replace(/<[^>]*>/g, ' ');
  return decodeEntities(once).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1] : null;
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1]);
  const alt = links.find((a) => /rel=["']alternate["']/i.test(a)) || links.find((a) => !/rel=/i.test(a)) || links[0];
  const h = alt && /href=["']([^"']+)["']/i.exec(alt);
  return h ? decodeEntities(h[1]) : null;
}

/** Retorna [{ id, title, link, summary, published, publisher }]. */
export function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  return blocks.map((b) => {
    const title = stripHtml(tag(b, 'title') || '');
    const link = isAtom ? atomLink(b) : stripHtml(tag(b, 'link') || '') || null;
    const summary = stripHtml(tag(b, isAtom ? 'summary' : 'description') || tag(b, 'content') || tag(b, 'content:encoded') || '');
    const published = stripHtml(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date') || '');
    const id = stripHtml(tag(b, 'guid') || tag(b, 'id') || '') || null;
    const publisher = stripHtml(tag(b, 'source') || '') || null; // Google News informa o veículo original aqui
    const t = Date.parse(published);
    return { id, title, link, summary, published: Number.isNaN(t) ? null : new Date(t).toISOString(), publisher };
  }).filter((i) => i.title && i.link);
}
