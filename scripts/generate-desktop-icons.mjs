import { mkdirSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const out = new URL('../electron/', import.meta.url);
const bolt = [[17.7, 6], [22, 6], [17.4, 14], [24, 14], [13.7, 26], [11.6, 26], [15, 18], [8, 18]];
const top = [0x25, 0x63, 0xeb], bottom = [0x1d, 0x4e, 0xd8];

function inBolt(x, y) {
  let inside = false;
  for (let i = 0, j = bolt.length - 1; i < bolt.length; j = i++) {
    const [ax, ay] = bolt[i], [bx, by] = bolt[j];
    if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
  }
  return inside;
}

function chunk(name, data) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(name, 4, 'ascii');
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

function render(size) {
  const stride = 1 + 4 * size, raw = Buffer.alloc(stride * size), samples = 6;
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let covered = 0, white = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const x = (col + (sx + 0.5) / samples) * 32 / size;
      const y = (row + (sy + 0.5) / samples) * 32 / size;
      const dx = Math.max(8 - x, 0, x - 24), dy = Math.max(8 - y, 0, y - 24);
      if (dx * dx + dy * dy > 49) continue;
      covered++;
      if (inBolt(x, y)) white++;
    }
    if (!covered) continue;
    const pixel = row * stride + 1 + col * 4, gradient = (col + row) / (2 * size - 2);
    for (let c = 0; c < 3; c++) {
      const blue = top[c] + (bottom[c] - top[c]) * gradient;
      raw[pixel + c] = Math.round(blue + (255 - blue) * white / covered);
    }
    raw[pixel + 3] = Math.round(255 * covered / (samples * samples));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Windows shortcuts need an ICO container. Embed each size at its native resolution.
const sizes = [16, 32, 48, 256], images = sizes.map(render);
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
sizes.forEach((size, i) => {
  const entry = 6 + i * 16;
  directory[entry] = directory[entry + 1] = size % 256;
  directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[i].length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
});
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon.png', out), images[sizes.indexOf(256)]);
writeFileSync(new URL('tray-icon.png', out), images[sizes.indexOf(32)]);
writeFileSync(new URL('icon.ico', out), Buffer.concat([directory, ...images]));
