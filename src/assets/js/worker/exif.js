// Header parsers for JPEG and PNG (DESIGN 6.5, C8, CS-5). They read sizes and the EXIF orientation
// from the file head and never decode pixels. Every loop moves forward and stops at SCAN_CAP_BYTES;
// every read is checked against the end of the data it belongs to. Pure functions, no dependencies.
//
// Both functions take a Uint8Array and return a plain object:
//   { ok: true, width, height, pixels, scanned, ... }   (JPEG adds orientation and tooBigToDecode)
//   { ok: false, code: 'DAMAGED' | 'IMAGE_TOO_BIG', scanned, ... }
// `scanned` is the number of bytes looked at, so the bound can be checked without a clock.

export const SCAN_CAP_BYTES = 1024 * 1024; // CS-5: nothing past 1 MiB is looked at
export const PIXEL_CAP = 16777216; // the iOS canvas cap (DESIGN 6.7), width x height

const MAX_IFD_ENTRIES = 256;
const ORIENTATION_TAG = 0x0112;
const TYPE_SHORT = 3;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_MAX_SIDE = 0x7fffffff;
// Allowed bit depths per PNG colour type.
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

const damaged = (scanned) => ({ ok: false, code: 'DAMAGED', scanned });
const isBytes = (x) => x instanceof Uint8Array;
const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

// The offset rule of CS-5: the next offset is a whole number, strictly greater than the current one
// and not past the scan cap. Returns the next offset, or -1.
export function nextOffset(current, next) {
  if (!Number.isInteger(next) || !Number.isInteger(current)) return -1;
  if (next <= current || next > SCAN_CAP_BYTES) return -1;
  return next;
}

// Reads the orientation (1-8) from an Exif APP1 payload, or returns 0. `start` and `end` delimit the
// payload; nothing outside it is read.
function readOrientation(b, start, end) {
  if (end - start < 14) return 0;
  const tag = [0x45, 0x78, 0x69, 0x66, 0, 0]; // Exif\0\0
  for (let i = 0; i < 6; i += 1) if (b[start + i] !== tag[i]) return 0;
  const base = start + 6;
  const size = end - base; // bytes of the TIFF block
  const little = b[base] === 0x49 && b[base + 1] === 0x49;
  const big = b[base] === 0x4d && b[base + 1] === 0x4d;
  if (!little && !big) return 0;
  const r16 = (at) => (little ? b[at] | (b[at + 1] << 8) : u16(b, at));
  if (r16(base + 2) !== 42) return 0;
  const ifd = little
    ? (b[base + 4] | (b[base + 5] << 8) | (b[base + 6] << 16) | (b[base + 7] << 24)) >>> 0
    : u32(b, base + 4);
  if (ifd < 8 || ifd + 2 > size) return 0;
  const declared = r16(base + ifd);
  const fit = Math.floor((size - ifd - 2) / 12);
  const count = Math.min(declared, fit, MAX_IFD_ENTRIES);
  for (let n = 0; n < count; n += 1) {
    const e = base + ifd + 2 + n * 12;
    if (r16(e) !== ORIENTATION_TAG) continue;
    const type = r16(e + 2);
    const items = little
      ? (b[e + 4] | (b[e + 5] << 8) | (b[e + 6] << 16) | (b[e + 7] << 24)) >>> 0
      : u32(b, e + 4);
    if (type !== TYPE_SHORT || items !== 1) return 0;
    const value = r16(e + 8);
    return value >= 1 && value <= 8 ? value : 0;
  }
  return 0;
}

const isFrameMarker = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

export function readJpegInfo(input) {
  if (!isBytes(input)) return damaged(0);
  const len = input.length;
  const limit = Math.min(len, SCAN_CAP_BYTES);
  const b = input;
  if (len < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return damaged(Math.min(len, 3));
  let pos = 2;
  let frame = null;
  let orientation = 0;
  // Each pass moves `pos` forward by at least one byte, so the loop ends within `limit` passes.
  while (pos < limit) {
    if (b[pos] !== 0xff) break; // not a marker
    // Fill bytes: any run of 0xFF before the marker code.
    let at = pos + 1;
    while (at < limit && b[at] === 0xff) at += 1;
    if (at >= limit) { pos = limit; break; }
    const marker = b[at];
    if (marker === 0x00 || marker === 0xd8) break; // a stuffed zero or a second SOI outside a scan
    if (marker === 0xd9) break; // EOI before any frame header
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // markers with no length
      const next = nextOffset(pos, at + 1);
      if (next < 0) { pos = limit; break; }
      pos = next;
      continue;
    }
    if (marker === 0xda) { pos = at + 1; break; } // start of scan: headers are over
    if (at + 3 >= len) { pos = limit; break; }
    const segLen = u16(b, at + 1);
    if (segLen < 2) break; // a length counts its own two bytes
    const end = at + 1 + segLen;
    const next = nextOffset(pos, end);
    if (next < 0 || end > len) { pos = Math.min(len, SCAN_CAP_BYTES); break; } // past the cap or the file
    const payload = at + 3;
    if (isFrameMarker(marker)) {
      if (!frame) {
        if (segLen < 8) break;
        const comps = b[payload + 5];
        if (comps < 1 || segLen < 8 + 3 * comps) break;
        const height = u16(b, payload + 1);
        const width = u16(b, payload + 3);
        if (width < 1 || height < 1) break;
        frame = { width, height, components: comps };
      }
    } else if (marker === 0xe1 && orientation === 0) {
      orientation = readOrientation(b, payload, end);
    }
    pos = next;
  }
  if (!frame) return damaged(Math.min(pos, SCAN_CAP_BYTES));
  const pixels = frame.width * frame.height;
  return {
    ok: true,
    width: frame.width,
    height: frame.height,
    components: frame.components,
    orientation: orientation || 1,
    pixels,
    tooBigToDecode: pixels > PIXEL_CAP, // a flag, not an error: a JPEG is converted without a decode
    scanned: Math.min(pos, SCAN_CAP_BYTES),
  };
}

export function readPngInfo(input) {
  if (!isBytes(input)) return damaged(0);
  const len = input.length;
  const b = input;
  if (len < 8) return damaged(len);
  for (let i = 0; i < 8; i += 1) if (b[i] !== PNG_SIGNATURE[i]) return damaged(i);
  // IHDR: length 13, type IHDR, 13 bytes of data, 4 of CRC.
  const IHDR_END = 8 + 8 + 13 + 4;
  if (len < IHDR_END) return damaged(len);
  if (u32(b, 8) !== 13 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return damaged(16);
  const width = u32(b, 16);
  const height = u32(b, 20);
  const depth = b[24];
  const color = b[25];
  const interlace = b[28];
  if (width < 1 || height < 1 || width > PNG_MAX_SIDE || height > PNG_MAX_SIDE) return damaged(IHDR_END);
  if (!PNG_DEPTHS[color] || !PNG_DEPTHS[color].includes(depth)) return damaged(IHDR_END);
  if (b[26] !== 0 || b[27] !== 0 || interlace > 1) return damaged(IHDR_END);
  const pixels = width * height;
  // The cap is checked here, before a single chunk after IHDR is read and long before any decode.
  if (pixels > PIXEL_CAP) return { ok: false, code: 'IMAGE_TOO_BIG', width, height, pixels, scanned: IHDR_END };
  // Walk the chunks up to the first IDAT. A chunk is 4 bytes of length, 4 of type, data, 4 of CRC.
  let pos = IHDR_END;
  while (pos < SCAN_CAP_BYTES) {
    if (pos + 12 > len) return damaged(Math.min(len, SCAN_CAP_BYTES));
    const size = u32(b, pos);
    const end = pos + 12 + size;
    if (end > len) return damaged(Math.min(len, SCAN_CAP_BYTES)); // the length points past the file
    const t0 = b[pos + 4];
    const t1 = b[pos + 5];
    const t2 = b[pos + 6];
    const t3 = b[pos + 7];
    if (t0 === 0x49 && t1 === 0x44 && t2 === 0x41 && t3 === 0x54) { // IDAT: the image data starts here
      return {
        ok: true, width, height, pixels, bitDepth: depth, colorType: color, interlaced: interlace === 1, scanned: pos + 8,
      };
    }
    if (t0 === 0x49 && t1 === 0x45 && t2 === 0x4e && t3 === 0x44) return damaged(pos + 8); // IEND with no data
    if (nextOffset(pos, end) < 0) return damaged(SCAN_CAP_BYTES); // past the cap
    pos = end;
  }
  return damaged(SCAN_CAP_BYTES);
}
