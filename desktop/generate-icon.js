// Generates a 1024x1024 RGBA PNG app-icon source with no external deps.
// Deep-rose accent background with a soft white "office" glyph mark.
const fs = require('fs');
const zlib = require('zlib');

const S = 1024;
const accent = [0xb1, 0x1f, 0x4b];
const accentDk = [0x9a, 0x1a, 0x41];
const white = [0xff, 0xff, 0xff];

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

const raw = Buffer.alloc(S * (S * 4 + 1));
let o = 0;
const cx = S / 2, cy = S / 2;
for (let y = 0; y < S; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    // vertical gradient background
    const t = y / S;
    let r = lerp(accent[0], accentDk[0], t);
    let g = lerp(accent[1], accentDk[1], t);
    let b = lerp(accent[2], accentDk[2], t);
    let a = 255;
    // rounded-square white mark with two "windows" cut out
    const half = S * 0.26;
    const rad = S * 0.07;
    const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
    const inSquare =
      dx <= half && dy <= half &&
      (dx <= half - rad || dy <= half - rad ||
        Math.hypot(dx - (half - rad), dy - (half - rad)) <= rad);
    if (inSquare) {
      r = white[0]; g = white[1]; b = white[2];
      // cut two rounded "windows" to read as an app/office tile
      const wx = S * 0.10, wy = S * 0.10, gap = S * 0.025;
      const cols = [cx - wx - gap / 2, cx + gap / 2];
      const rows = [cy - wy - gap / 2 + S * 0.02, cy + gap / 2 + S * 0.02];
      for (const wcx of cols) {
        for (const wcy of rows) {
          if (x >= wcx && x <= wcx + wx && y >= wcy && y <= wcy + wy) {
            const tt = (y - (cy - S * 0.16)) / (S * 0.32);
            r = lerp(accent[0], accentDk[0], Math.max(0, Math.min(1, tt)));
            g = lerp(accent[1], accentDk[1], Math.max(0, Math.min(1, tt)));
            b = lerp(accent[2], accentDk[2], Math.max(0, Math.min(1, tt)));
          }
        }
      }
    }
    raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

const CRC_TABLE = (() => {
  const tbl = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tbl[n] = c;
  }
  return tbl;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c;
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync('icon-source.png', png);
console.log('Wrote icon-source.png', png.length, 'bytes');
