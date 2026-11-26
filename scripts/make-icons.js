// Gera os ícones PNG do app (sem dependências): fundo verde-azulado com uma linha ascendente branca.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };

function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [15, 76, 92], fg = [255, 255, 255];
  // Linha M(6,21) L(12,14) L(17,18) L(26,7) numa grade 32x32, desenhada como segmentos com espessura
  const pts = [[6, 21], [12, 14], [17, 18], [26, 7]].map(([x, y]) => [(x / 32) * size, (y / 32) * size]);
  const w = size * 0.055;
  const dist = (x, y, [x1, y1], [x2, y2]) => { const dx = x2 - x1, dy = y2 - y1, t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)); };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.min(...[0, 1, 2].map((i) => dist(x + 0.5, y + 0.5, pts[i], pts[i + 1])));
    const a = Math.max(0, Math.min(1, w + 0.5 - d)); // suavização de borda
    const o = (y * size + x) * 4;
    for (let k = 0; k < 3; k++) px[o + k] = Math.round(bg[k] * (1 - a) + fg[k] * a);
    px[o + 3] = 255;
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [192, 512]) writeFileSync(`public/icon-${s}.png`, icon(s));
console.log('Ícones gerados em public/');
