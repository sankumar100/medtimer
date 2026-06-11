// Generates icon-192.png and icon-512.png using only Node.js builtins
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// CRC32 table
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const body = Buffer.concat([tb, data]);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crcBuf]);
}

function makePNG(size) {
  const bg = [26, 26, 46];      // #1a1a2e
  const fg = [224, 169, 109];   // #e0a96d  (accent/bell color)
  const ring = [255, 255, 255]; // white ring detail

  const cx = size / 2, cy = size / 2;
  const outerR = size * 0.42;
  const innerR = size * 0.28;
  const dotR   = size * 0.08;

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter byte = None
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let r, g, b, a;
      if (dist <= outerR) {
        if (dist <= dotR) {
          // Center dot (clapper)
          [r, g, b] = ring; a = 255;
        } else if (dist <= innerR) {
          // Inner fill (lighter accent)
          r = Math.round(fg[0] * 0.6 + bg[0] * 0.4);
          g = Math.round(fg[1] * 0.6 + bg[1] * 0.4);
          b = Math.round(fg[2] * 0.6 + bg[2] * 0.4);
          a = 255;
        } else {
          // Outer ring
          [r, g, b] = fg; a = 255;
        }
      } else {
        [r, g, b] = bg; a = 255;
      }
      row.push(r, g, b, a);
    }
    rows.push(Buffer.from(row));
  }

  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 6;   // color type RGBA
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdrData),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, 'icons');
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

fs.writeFileSync(path.join(dir, 'icon-192.png'), makePNG(192));
fs.writeFileSync(path.join(dir, 'icon-512.png'), makePNG(512));
console.log('Icons generated: icons/icon-192.png, icons/icon-512.png');
