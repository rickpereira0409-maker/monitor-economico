// Extrai o texto de um PDF no próprio navegador (nada é enviado para fora do aparelho).
// A biblioteca pdf.js fica em ./vendor/pdfjs e só é carregada quando o usuário anexa um PDF.

/** Agrupa os pedaços de texto de cada página em linhas; colunas distantes viram separação por dois espaços. */
export async function textFromPdfDoc(doc) {
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = [];
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5], x = it.transform[4];
      let row = rows.find((r) => Math.abs(r.y - y) < 3);
      if (!row) { row = { y, parts: [] }; rows.push(row); }
      row.parts.push({ x, w: it.width || 0, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.parts.sort((a, b) => a.x - b.x);
      let line = '', end = null;
      for (const part of r.parts) {
        if (end != null) line += part.x - end > 24 ? '  ' : part.x - end > 1 ? ' ' : '';
        line += part.s; end = part.x + part.w;
      }
      out.push(line.trim());
    }
  }
  return out.join('\n');
}

export async function readPdf(file) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  return textFromPdfDoc(doc);
}
