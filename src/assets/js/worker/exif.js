// Header parsers for JPEG and PNG (DESIGN 6.5, C8, CS-5). They read sizes and the EXIF orientation
// from the file head and never decode pixels. Every loop moves forward and stops at SCAN_CAP_BYTES;
// every read is checked against the end of the data it belongs to. Pure functions, no dependencies.
//
// The functions take a Uint8Array and return a plain object:
//   { ok: true, width, height, pixels, scanned, ... }   (JPEG adds orientation and tooBigToDecode)
//   { ok: false, code: 'DAMAGED' | 'IMAGE_TOO_BIG', scanned, ... }
// `scanned` is the number of bytes looked at, so the bound can be checked without a clock.
//
// The engine's own decoders read more of a file than these head parsers do (decision 32), so the
// parsers refuse what the engine would read differently:
//   - JPEG: C8, CC and F0-FD segments before the frame header, component counts other than 1, 3, 4, and
//     (SEC-8) fill bytes, TEM and RST markers before the frame header.
//   - PNG: a second IHDR, APNG chunks (acTL, fcTL, fdAT) and CgBI, and chunk lengths past the file.
// readPngInfo looks only inside the first 1 MiB. checkPngChunks walks the whole file; THE WORKER MUST
// CALL IT ON EVERY PNG BEFORE ANY EMBED (it is the only check that covers chunks past 1 MiB).

export const SCAN_CAP_BYTES = 1024 * 1024; // CS-5: nothing past 1 MiB is looked at
export const PIXEL_CAP = 16777216; // the iOS canvas cap (DESIGN 6.7), width x height

const MAX_IFD_ENTRIES = 256;
const ORIENTATION_TAG = 0x0112;
const TYPE_SHORT = 3;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_MAX_SIDE = 0x7fffffff;
const PNG_MIN_CHUNK = 12; // length (4) + type (4) + CRC (4)
// Allowed bit depths per PNG colour type.
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

const damaged = (scanned) => ({ ok: false, code: 'DAMAGED', scanned });
const isBytes = (x) => x instanceof Uint8Array;
const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const typeIs = (b, at, name) => b[at] === name.charCodeAt(0) && b[at + 1] === name.charCodeAt(1)
  && b[at + 2] === name.charCodeAt(2) && b[at + 3] === name.charCodeAt(3);

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

// True when the APP1 payload starts with Exif followed by two zero bytes.
function isExifPayload(b, start, end) {
  if (end - start < 6) return false;
  const tag = [0x45, 0x78, 0x69, 0x66, 0, 0];
  for (let i = 0; i < 6; i += 1) if (b[start + i] !== tag[i]) return false;
  return true;
}

// Segments the engine's scan reads as a frame header (C8, CC) or that are reserved extensions (F0-FD).
const isUnsafeBeforeFrame = (m) => m === 0xc8 || m === 0xcc || (m >= 0xf0 && m <= 0xfd);

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
  let exifSeen = false; // only the first Exif APP1 decides the orientation
  // Each pass moves `pos` forward by at least one byte, so the loop ends within `limit` passes.
  while (pos < limit) {
    if (b[pos] !== 0xff) break; // not a marker
    // Fill bytes: any run of 0xFF before the marker code.
    let at = pos + 1;
    while (at < limit && b[at] === 0xff) at += 1;
    if (!frame && at > pos + 1) break; // SEC-8: fill bytes before the frame header; the engine's scan reads them as a length
    if (at >= limit) { pos = limit; break; }
    const marker = b[at];
    if (marker === 0x00 || marker === 0xd8) break; // a stuffed zero or a second SOI outside a scan
    if (marker === 0xd9) break; // EOI before any frame header
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // markers with no length
      if (!frame) break; // SEC-8: TEM and RST before the frame header; the engine's scan would read a length from them
      const next = nextOffset(pos, at + 1);
      if (next < 0) { pos = limit; break; }
      pos = next;
      continue;
    }
    if (marker === 0xda) { pos = at + 1; break; } // start of scan: headers are over
    if (!frame && isUnsafeBeforeFrame(marker)) break; // the engine could pick a different frame header
    if (at + 3 > limit) { pos = limit; break; } // the two length bytes must be below the cap
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
        if ((comps !== 1 && comps !== 3 && comps !== 4) || segLen < 8 + 3 * comps) break; // the engine takes only 1, 3, 4
        const height = u16(b, payload + 1);
        const width = u16(b, payload + 3);
        if (width < 1 || height < 1) break;
        frame = { width, height, components: comps };
      }
    } else if (marker === 0xe1 && !exifSeen && isExifPayload(b, payload, end)) {
      exifSeen = true;
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

const IHDR_END = 8 + 8 + 13 + 4;

// Checks the signature and the IHDR. Returns { width, height, pixels, depth, color, interlace } or a
// failure result (recognised by `.ok === false`).
function readPngHead(b, len) {
  if (len < 8) return damaged(len);
  for (let i = 0; i < 8; i += 1) if (b[i] !== PNG_SIGNATURE[i]) return damaged(i);
  // IHDR: length 13, type IHDR, 13 bytes of data, 4 of CRC.
  if (len < IHDR_END) return damaged(len);
  if (u32(b, 8) !== 13 || !typeIs(b, 12, 'IHDR')) return damaged(16);
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
  return { width, height, pixels, depth, color, interlace };
}

// Chunk types the engine would read differently from the parsers: another IHDR, APNG frames, CgBI.
const isRefusedChunk = (b, at) => typeIs(b, at, 'IHDR') || typeIs(b, at, 'acTL') || typeIs(b, at, 'fcTL')
  || typeIs(b, at, 'fdAT') || typeIs(b, at, 'CgBI');

// Head parser: size, depth and colour type from IHDR, then a walk over the chunk headers inside the
// first 1 MiB (the walk continues past the first IDAT, so a second IHDR or an APNG chunk right after
// the image data is seen). The cost is bounded by SCAN_CAP_BYTES; the rest is checkPngChunks' job.
// `fileLength` (optional): the real size of the file when `input` is only its first bytes (the page reads 1 MiB
// on add). A chunk that runs past it is DAMAGED; one that runs past the window but not past the file is fine.
export function readPngInfo(input, fileLength) {
  if (!isBytes(input)) return damaged(0);
  const len = input.length;
  const total = Number.isSafeInteger(fileLength) && fileLength > len ? fileLength : len;
  const b = input;
  const head = readPngHead(b, len);
  if (head.ok === false) return head;
  const { width, height, pixels, depth, color, interlace } = head;
  const result = (scanned) => ({
    ok: true, width, height, pixels, bitDepth: depth, colorType: color, interlaced: interlace === 1, scanned,
  });
  let pos = IHDR_END;
  let sawData = false; // an IDAT was seen
  // A chunk is 4 bytes of length, 4 of type, data, 4 of CRC. Each pass moves at least 12 bytes forward.
  while (pos < SCAN_CAP_BYTES) {
    if (pos === total && sawData) return result(pos); // the file ends right after the image data
    if (pos + 8 > SCAN_CAP_BYTES) break; // the next chunk header is not entirely below the cap
    if (pos + PNG_MIN_CHUNK > total) return damaged(Math.min(total, SCAN_CAP_BYTES));
    if (pos + 8 > len) break; // the window ends inside this header; the file goes on
    const size = u32(b, pos);
    const end = pos + PNG_MIN_CHUNK + size;
    if (end > total) return damaged(Math.min(total, SCAN_CAP_BYTES)); // the length points past the file
    if (isRefusedChunk(b, pos + 4)) return damaged(pos + 8);
    if (typeIs(b, pos + 4, 'IDAT')) {
      sawData = true;
    } else if (typeIs(b, pos + 4, 'IEND')) {
      return sawData ? result(pos + 8) : damaged(pos + 8); // IEND with no data is not an image
    }
    if (nextOffset(pos, end) < 0) break; // the next chunk starts past the cap
    pos = end;
  }
  return sawData ? result(SCAN_CAP_BYTES) : damaged(SCAN_CAP_BYTES);
}

// Whole-file chunk check, for the worker to call before any embed (decision 32). It walks every chunk
// header up to IEND, never reads chunk data (8 bytes per chunk), and every step is at least 12 bytes,
// so the cost is bounded by the file length. It refuses what readPngInfo refuses, wherever it is in the
// file, and also: a length past the file, no IDAT, no IEND, and data after IEND that could hold a chunk.
// On success it returns { ok: true, width, height, pixels, chunks, scanned }.
export function checkPngChunks(input) {
  if (!isBytes(input)) return damaged(0);
  const len = input.length;
  const b = input;
  const head = readPngHead(b, len);
  if (head.ok === false) return head;
  let pos = IHDR_END;
  let chunks = 1;
  let sawData = false;
  while (pos < len) {
    if (pos + PNG_MIN_CHUNK > len) return damaged(pos);
    const size = u32(b, pos);
    const end = pos + PNG_MIN_CHUNK + size;
    if (end > len) return damaged(pos); // the length points past the file
    if (isRefusedChunk(b, pos + 4)) return damaged(pos + 8);
    chunks += 1;
    if (typeIs(b, pos + 4, 'IDAT')) sawData = true;
    if (typeIs(b, pos + 4, 'IEND')) {
      if (!sawData) return damaged(pos + 8);
      if (len - end >= PNG_MIN_CHUNK) return damaged(end); // a chunk after IEND
      return { ok: true, width: head.width, height: head.height, pixels: head.pixels, chunks, scanned: end };
    }
    pos = end;
  }
  return damaged(len); // the file ended without IEND
}
