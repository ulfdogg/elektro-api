// Erzeugt PWA-App-Icons (PNG) rein mit Node-Bordmitteln (zlib), ohne externe
// Bildbibliothek. Zeichnet ein einfaches blaues Quadrat mit weißem Blitz-Symbol.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── Zeichnen ────────────────────────────────────────────────────────────────
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function drawIcon(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = [37, 99, 235];      // #2563eb (Toolbar-Blau)
  const bgDark = [29, 78, 216];  // #1d4ed8
  const bolt = [255, 255, 255];
  // Bei maskable-Icons muss der Inhalt in der mittleren "safe zone" (~80%) bleiben
  const pad = maskable ? size * 0.1 : 0;
  const r = maskable ? 0 : size * 0.22; // Eckenradius (nur nicht-maskable)
  const inner = size - pad * 2;
  // Blitz-Polygon (klassische Zickzack-Form), normiert auf 0..100 im inneren Bereich
  const boltPts = [
    [58, 8], [30, 54], [48, 54], [40, 92], [72, 42], [52, 42]
  ].map(([x, y]) => [pad + x / 100 * inner, pad + y / 100 * inner]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Rundes-Rechteck-Maske (nur bei nicht-maskable)
      let alpha = 255;
      if (!maskable) {
        const cx = Math.min(x, size - 1 - x), cy = Math.min(y, size - 1 - y);
        if (cx < r && cy < r) {
          const dx = r - cx, dy = r - cy;
          if (dx * dx + dy * dy > r * r) alpha = 0;
        }
      }
      const t = y / size; // sanfter Verlauf oben->unten
      const col = alpha === 0 ? [0, 0, 0] : [
        Math.round(bg[0] + (bgDark[0] - bg[0]) * t),
        Math.round(bg[1] + (bgDark[1] - bg[1]) * t),
        Math.round(bg[2] + (bgDark[2] - bg[2]) * t)
      ];
      if (alpha !== 0 && pointInPoly(x + 0.5, y + 0.5, boltPts)) {
        col[0] = bolt[0]; col[1] = bolt[1]; col[2] = bolt[2];
      }
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = alpha;
    }
  }
  return buf;
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'icon-maskable-192.png', size: 192, maskable: true },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
];
for (const t of targets) {
  const rgba = drawIcon(t.size, { maskable: !!t.maskable });
  const png = encodePNG(t.size, t.size, rgba);
  fs.writeFileSync(path.join(outDir, t.name), png);
  console.log('wrote', t.name, png.length, 'bytes');
}

// favicon (kleines PNG, wird als solches referenziert statt echtem .ico)
const favRgba = drawIcon(64, {});
fs.writeFileSync(path.join(outDir, '..', 'favicon.png'), encodePNG(64, 64, favRgba));
console.log('wrote favicon.png');
