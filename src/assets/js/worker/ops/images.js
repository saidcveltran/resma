// Op `images`: turn JPG and PNG files into one PDF, one page per image, in the order given.
//
// What the op guarantees (DESIGN 6.5, CS-5, CS-6, decisions 32 and 33):
//   - JPEG: the head parser vets the file, then the bytes are cut byte-wise and go to embedJpg without
//     re-encoding. Only JFIF (APP0), ICC_PROFILE (APP2) and Adobe (APP14) segments stay; every other APPn
//     and COM is dropped (Exif, XMP, IPTC, C2PA, MPF, thumbnails), and so is everything after the image's
//     first end-of-image marker (motion-photo video, extra images). A metadata segment that runs past the
//     end of the file is DAMAGED.
//   - PNG: the file is walked chunk by chunk, rebuilt from IHDR, PLTE, tRNS, the IDAT chunks and IEND only,
//     and its IDAT stream is inflated here, with an output cap taken from the header, BEFORE the library
//     or the canvas sees it. A stream that inflates past the cap (a decompression bomb) is DAMAGED.
//   - After the library has parsed an image, its width, height and channel kind must equal what our
//     parsers read; a difference is DAMAGED (the two readers disagree about the file).
//   - A 16-bit PNG, or one the library cannot embed, is redrawn on an OffscreenCanvas as an 8-bit PNG;
//     the canvas and the bitmap are released after use.
import { EngineError, isResourceError } from '../errors.js';
import { readJpegInfo, readPngInfo, checkPngChunks } from '../exif.js';
import { place } from '../layout.js';
import { readFiles } from './inspect.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }; // samples per pixel by PNG colour type
const ENGINE_PNG_TYPE = { 0: 'Greyscale', 2: 'Truecolour', 3: 'IndexedColour', 4: 'GreyscaleWithAlpha', 6: 'TruecolourWithAlpha' };
const JPEG_COLOR_SPACE = { 1: 'DeviceGray', 3: 'DeviceRGB', 4: 'DeviceCMYK' };
// Adam7 passes: [x start, y start, x step, y step].
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const SIZES = new Set(['a4', 'letter', 'image']);
const ORIENTATIONS = new Set(['auto', 'portrait', 'landscape']);
const MARGINS = new Set(['small', 'none']);

const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const typeAt = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

// ------------------------------------------------------------------ JPEG

// Cuts a JPEG down to its picture: keeps the image segments and the three APP segments that describe how to
// show it (APP0 JFIF, APP2 ICC_PROFILE, APP14 Adobe), drops every other APPn and COM wherever it sits, and
// ends the output at the first EOI that follows the first SOS. A segment is 0xFF, a marker, a length that
// counts its own two bytes, and the payload; inside the compressed data every 0xFF is followed by a zero or
// a restart marker, so a marker with a length is always a real segment and the first EOI marker is the end of
// the image. The three kept segments are cut to what they need (decision 36): JFIF to its 16-byte header with
// a 0 x 0 thumbnail, Adobe to 14 bytes, and the ICC chunks stay only if together they parse as one ICC
// profile (decision 47). DAMAGED: an APPn or COM that runs past the end of the file; a byte that is not a
// marker, or a segment shorter than its own length field, before the first scan; no EOI after the scan (text
// after the scan cannot be told from image data). Each pass moves forward, so the cost is bounded by the file.
const KEEP_APP = new Map([
  [0xe0, Uint8Array.from([0x4a, 0x46, 0x49, 0x46, 0x00])], // JFIF, then a zero byte
  [0xe2, Uint8Array.from([0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00])], // ICC_PROFILE, then a zero byte
  [0xee, Uint8Array.from([0x41, 0x64, 0x6f, 0x62, 0x65])], // Adobe
]);
const startsWith = (b, at, prefix) => at + prefix.length <= b.length && prefix.every((v, k) => b[at + k] === v);

// JFIF and Adobe: null keeps the segment as it is, otherwise the bytes that replace it (none: dropped).
function shorten(b, marker, size, at) {
  const head = marker === 0xe0 ? [0xff, 0xe0, 0, 16] : [0xff, 0xee, 0, 14];
  if (marker === 0xee ? size <= 14 : size === 16 && b[at + 12] === 0 && b[at + 13] === 0) return null;
  if (size < head[3]) return new Uint8Array(0); // too short to be what it says
  const out = new Uint8Array(head[3] + 2);
  out.set(head);
  out.set(b.subarray(at, at + 12), 4); // the rest of a JFIF header (the thumbnail size) stays 0 x 0
  return out;
}

// True when the chunks of an ICC_PROFILE (sequence numbers 1..n, each once) join into a profile whose size field
// equals its length and that has `acsp` at offset 36.
function parsesAsIcc(b, chunks) {
  const parts = new Array(chunks.length).fill(null);
  let total = 0;
  for (const c of chunks) {
    const seq = b[c.at + 12];
    if (c.size < 16 || b[c.at + 13] !== chunks.length || seq < 1 || seq > chunks.length || parts[seq - 1]) return false;
    parts[seq - 1] = b.subarray(c.at + 14, c.to);
    total += parts[seq - 1].length;
  }
  if (total < 128) return false;
  const p = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { p.set(part, at); at += part.length; }
  return u32(p, 0) === total && typeAt(p, 36) === 'acsp';
}

export function stripJpegMetadata(b) {
  const len = b.length;
  let cuts = []; // { from, to, rep }: bytes [from, to) are replaced by rep (nothing when rep is null)
  const icc = [];
  let end = len;
  let sawScan = false;
  let ended = false;
  let i = 2;
  while (i < len) {
    if (b[i] !== 0xff) {
      if (!sawScan) throw new EngineError('DAMAGED'); // a stray byte between the headers
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < len && b[j] === 0xff) j += 1; // fill bytes
    if (j + 2 >= len && !(sawScan && b[j] === 0xd9)) break; // no room for a marker and its length
    const marker = b[j];
    if (marker === 0xd9 && sawScan) { end = j + 1; ended = true; break; } // the end of the image: nothing after it is kept
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i = j + 1; continue; }
    const size = (b[j + 1] << 8) | b[j + 2];
    const isApp = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (size < 2) throw new EngineError('DAMAGED'); // a length shorter than its own two bytes: text follows
    if (j + 1 + size > len) {
      if (isApp) throw new EngineError('DAMAGED'); // a metadata segment that runs past the end of the file
      i = j + 1;
      continue;
    }
    const segmentEnd = j + 1 + size;
    if (marker === 0xda) sawScan = true;
    if (isApp) {
      if (!(KEEP_APP.has(marker) && startsWith(b, j + 3, KEEP_APP.get(marker)))) {
        cuts.push({ from: i, to: segmentEnd, rep: null });
      } else if (marker === 0xe2) {
        icc.push({ from: i, to: segmentEnd, rep: null, at: j + 3, size });
        cuts.push(icc[icc.length - 1]);
      } else {
        const rep = shorten(b, marker, size, j + 3);
        if (rep) cuts.push({ from: i, to: segmentEnd, rep });
      }
    }
    i = segmentEnd;
  }
  if (!ended) throw new EngineError('DAMAGED');
  if (icc.length > 0 && parsesAsIcc(b, icc)) cuts = cuts.filter((c) => !icc.includes(c)); // a whole profile stays as it is
  if (cuts.length === 0) return end === len ? b : b.subarray(0, end);
  const out = new Uint8Array(cuts.reduce((n, c) => n + (c.rep ? c.rep.length : 0) - (c.to - c.from), end));
  let at = 0;
  let from = 0;
  for (const c of cuts) {
    out.set(b.subarray(from, c.from), at);
    at += c.from - from;
    if (c.rep) { out.set(c.rep, at); at += c.rep.length; }
    from = c.to;
  }
  out.set(b.subarray(from, end), at);
  return out;
}

async function embedJpeg(doc, bytes) {
  const info = readJpegInfo(bytes);
  if (!info.ok) throw new EngineError(info.code);
  const clean = stripJpegMetadata(bytes);
  const again = readJpegInfo(clean);
  if (!again.ok || again.width !== info.width || again.height !== info.height || again.components !== info.components) {
    throw new EngineError('DAMAGED');
  }
  let image;
  try {
    image = await doc.embedJpg(clean);
  } catch (err) {
    if (isResourceError(err)) throw err;
    throw new EngineError('DAMAGED');
  }
  if (image.width !== info.width || image.height !== info.height
    || image.embedder?.colorSpace !== JPEG_COLOR_SPACE[info.components]) {
    throw new EngineError('DAMAGED');
  }
  return { image, width: info.width, height: info.height, orientation: info.orientation };
}

// ------------------------------------------------------------------ PNG

// The exact size of the filtered scanlines of the image: height * (1 + ceil(width * bitsPerPixel / 8)),
// or, for an interlaced image, the same sum over its seven passes (each pass row has its own filter byte).
export function expectedRawSize({ width, height, bitDepth, colorType, interlaced }) {
  const bits = CHANNELS[colorType] * bitDepth;
  if (!interlaced) return height * (1 + Math.ceil((width * bits) / 8));
  let total = 0;
  for (const [x0, y0, dx, dy] of ADAM7) {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (w > 0 && h > 0) total += h * (1 + Math.ceil((w * bits) / 8));
  }
  return total;
}

// The most compressed bytes handed to the decompressor in one write. Browsers inflate the whole output of a
// write into memory before the reader can count it (up to 1,032 times the input, the deflate limit), so the
// slice, not the file, sets the memory of one step: about 1,032 x 16 KiB = 16 MiB.
export const INFLATE_SLICE_BYTES = 16 * 1024;

// Inflates a zlib stream and only counts the output; nothing is kept. The stream is written in slices of at
// most INFLATE_SLICE_BYTES, whatever the PNG's chunking was, the count is checked on every chunk the
// decompressor produces, and writing stops and the stream is cancelled the moment the count passes the cap.
// So the work is bounded by the cap plus one slice's output, and the memory of one step by about 1,032 times
// the slice size, not by the stream. DecompressionStream is native in workers (and in Node), so no code is
// added to the engine. `bytes` is one Uint8Array. Returns { ok, size, over }: ok means the stream ended
// cleanly inside the cap.
export async function inflateCapped(bytes, cap) {
  if (typeof DecompressionStream !== 'function') throw new EngineError('INTERNAL');
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let size = 0;
  let over = false;
  let ok = false;
  let stop = false;
  const feed = (async () => {
    try {
      for (let at = 0; at < bytes.length && !stop; at += INFLATE_SLICE_BYTES) {
        await writer.write(bytes.subarray(at, at + INFLATE_SLICE_BYTES));
      }
      if (!stop) await writer.close();
    } catch { /* the reader reports the failure, or the cancel below ended the stream */ }
  })();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { ok = true; break; }
      size += value.length;
      if (size > cap) { over = true; break; }
    }
  } catch {
    ok = false; // corrupt, truncated or trailing data
  }
  stop = true;
  if (over || !ok) {
    try { await reader.cancel(); } catch { /* already closed */ }
    try { await writer.abort(); } catch { /* already closed */ }
  }
  await feed;
  return { ok: ok && !over, size, over };
}

const chunkBytes = (b, at, size) => b.subarray(at, at + 12 + size);
const IEND_CHUNK = Uint8Array.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

// Vets a PNG and rebuilds it from IHDR, PLTE (indexed colour only), tRNS, the IDAT chunks and IEND.
// Everything else (text, Exif, colour profiles, time, anything unknown) is dropped. Throws EngineError
// (DAMAGED, IMAGE_TOO_BIG, INTERNAL). Returns { bytes, info } where info is readPngInfo's result.
export async function preparePng(b) {
  const info = readPngInfo(b);
  if (!info.ok) throw new EngineError(info.code);
  const whole = checkPngChunks(b); // the walk past the first MiB that readPngInfo does not do
  if (!whole.ok) throw new EngineError(whole.code);
  const indexed = info.colorType === 3;
  let ihdr = null;
  let plte = null;
  let trns = null;
  let idatStart = -1; // the IDAT chunks are one run of the file, from idatStart to idatEnd
  let idatEnd = -1;
  let idatEnded = false;
  let at = 8;
  while (at + 12 <= b.length) {
    const size = u32(b, at);
    const type = typeAt(b, at + 4);
    if (type === 'IHDR' && ihdr === null) {
      ihdr = chunkBytes(b, at, size);
    } else if (type === 'IDAT') {
      if (idatEnded) throw new EngineError('DAMAGED'); // image data split by another chunk
      if (idatStart < 0) idatStart = at;
      idatEnd = at + 12 + size;
    } else {
      if (idatStart >= 0) idatEnded = true;
      if (idatStart < 0 && type === 'PLTE' && indexed && plte === null) plte = chunkBytes(b, at, size);
      else if (idatStart < 0 && type === 'tRNS' && trns === null) trns = chunkBytes(b, at, size);
    }
    if (type === 'IEND') break;
    at += 12 + size;
  }
  if (ihdr === null || idatStart < 0) throw new EngineError('DAMAGED');
  if (indexed) {
    const entries = plte === null ? 0 : (plte.length - 12) / 3;
    if (plte === null || !Number.isInteger(entries) || entries < 1 || entries > 2 ** info.bitDepth) throw new EngineError('DAMAGED');
    if (trns !== null && trns.length - 12 > entries) throw new EngineError('DAMAGED');
  } else if (trns !== null) {
    // Grey and truecolour carry one transparent colour; the types with their own alpha carry none.
    const want = info.colorType === 0 ? 2 : info.colorType === 2 ? 6 : -1;
    if (want === -1) trns = null;
    else if (trns.length - 12 !== want) throw new EngineError('DAMAGED');
  }
  // The image data: the IDAT payloads are copied once into one buffer (never larger than the file), so the
  // decompressor sees slices of INFLATE_SLICE_BYTES whatever the chunking, and inflated here, once, against
  // the cap taken from the header.
  const joined = new Uint8Array(Math.min(idatEnd, b.length) - idatStart);
  let used = 0;
  for (let p = idatStart; p < idatEnd; p += 12 + u32(b, p)) {
    const payload = b.subarray(p + 8, p + 8 + u32(b, p));
    joined.set(payload, used);
    used += payload.length;
  }
  const cap = expectedRawSize(info);
  const inflated = await inflateCapped(joined.subarray(0, used), cap);
  if (!inflated.ok || inflated.size !== cap) throw new EngineError('DAMAGED');
  const list = [Uint8Array.from(PNG_SIGNATURE), ihdr, ...(plte ? [plte] : []), ...(trns ? [trns] : []), b.subarray(idatStart, idatEnd), IEND_CHUNK];
  const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of list) { out.set(p, pos); pos += p.length; }
  return { bytes: out, info };
}

const canvasAvailable = (env) => typeof env?.OffscreenCanvas === 'function' && typeof env?.createImageBitmap === 'function';

// Redraws a vetted PNG as an 8-bit PNG with the browser's own decoder. Returns the new PNG bytes, or null
// when the browser cannot do it. A bitmap of another size than the parser read is DAMAGED. The bitmap and
// the canvas are released in every case (the canvas is shrunk to 0 x 0 so its pixels can be freed).
async function redrawOnCanvas(env, png, info) {
  let bitmap = null;
  let canvas = null;
  try {
    bitmap = await env.createImageBitmap(new Blob([png], { type: 'image/png' }));
    if (bitmap.width !== info.width || bitmap.height !== info.height) throw new EngineError('DAMAGED');
    canvas = new env.OffscreenCanvas(info.width, info.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } catch (err) {
    if (err instanceof EngineError || isResourceError(err)) throw err;
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

function checkEnginePng(image, info, direct) {
  if (image.width !== info.width || image.height !== info.height) throw new EngineError('DAMAGED');
  // A canvas redraw is always RGBA; only a direct embed keeps the colour type the parser read.
  if (direct && image.embedder?.image?.type !== ENGINE_PNG_TYPE[info.colorType]) throw new EngineError('DAMAGED');
}

async function embedPngFile(doc, bytes, env) {
  const prep = await preparePng(bytes);
  const { info } = prep;
  const direct = async () => {
    try {
      const image = await doc.embedPng(prep.bytes);
      checkEnginePng(image, info, true);
      return image;
    } catch (err) {
      if (err instanceof EngineError || isResourceError(err)) throw err;
      return null;
    }
  };
  const viaCanvas = async () => {
    if (!canvasAvailable(env)) return null;
    const redrawn = await redrawOnCanvas(env, prep.bytes, info);
    if (redrawn === null) return null;
    const again = await preparePng(redrawn); // the browser's file gets the same vetting
    if (again.info.width !== info.width || again.info.height !== info.height) throw new EngineError('DAMAGED');
    try {
      const image = await doc.embedPng(again.bytes);
      checkEnginePng(image, info, false);
      return image;
    } catch (err) {
      if (err instanceof EngineError || isResourceError(err)) throw err;
      return null;
    }
  };
  // 16-bit samples are reduced by the browser (colour managed); everything else tries the library first.
  const order = info.bitDepth === 16 ? [viaCanvas, direct] : [direct, viaCanvas];
  for (const attempt of order) {
    const image = await attempt();
    if (image) return { image, width: info.width, height: info.height, orientation: 1 };
  }
  throw new EngineError('IMAGE_UNSUPPORTED');
}

// ------------------------------------------------------------------ the op

const isJpeg = (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b) => b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v);

// Only the listed values reach the layout math; anything else is the default.
function readOptions(options) {
  const o = options !== null && typeof options === 'object' ? options : {};
  return {
    size: SIZES.has(o.size) ? o.size : 'a4',
    orientation: ORIENTATIONS.has(o.orientation) ? o.orientation : 'auto',
    margin: MARGINS.has(o.margin) ? o.margin : 'small',
  };
}

export async function run({ files, options }, lib, progress = () => {}, env = globalThis) {
  const inputs = readFiles(files);
  const opts = readOptions(options);
  const total = inputs.length;
  const out = await lib.PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < total; i++) {
    const { index, bytes } = inputs[i];
    try {
      let picture;
      if (isJpeg(bytes)) picture = await embedJpeg(out, bytes);
      else if (isPng(bytes)) picture = await embedPngFile(out, bytes, env);
      else throw new EngineError('WRONG_TYPE');
      const { page, ctm } = place(picture, opts);
      const leaf = out.addPage([page.width, page.height]);
      leaf.node.setXObject(lib.PDFName.of('Im0'), picture.image.ref);
      leaf.pushOperators(
        lib.pushGraphicsState(),
        lib.concatTransformationMatrix(...ctm),
        lib.drawObject('Im0'),
        lib.popGraphicsState(),
      );
    } catch (err) {
      if (err instanceof EngineError) throw new EngineError(err.code, index);
      if (isResourceError(err)) throw new EngineError('TOO_LARGE', index);
      throw new EngineError('INTERNAL', index);
    }
    inputs[i].bytes = null; // the embedded copy is enough from here on
    progress(i + 1, total);
  }
  // No title, author, subject, keywords or dates: only the tool name.
  out.setProducer('resma');
  out.setCreator('resma');
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, pages: out.getPageCount() };
}
