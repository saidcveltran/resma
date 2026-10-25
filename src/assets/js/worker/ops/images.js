// Op `images`: turn JPG and PNG files into one PDF, one page per image, in the order given.
//
// What the op guarantees (DESIGN 6.5, CS-5, CS-6, decisions 32 and 33):
//   - JPEG: the head parser vets the file, APP1 (Exif, XMP) and APP13 (IPTC) are cut out byte-wise, and
//     the bytes go to embedJpg without re-encoding. APP0, APP2 (ICC) and APP14 (Adobe) stay.
//   - PNG: the file is walked chunk by chunk, rebuilt from IHDR, PLTE, tRNS, the IDAT chunks and IEND only,
//     and its IDAT stream is inflated here, with an output cap taken from the header, BEFORE the library
//     or the canvas sees it. A stream that inflates past the cap (a decompression bomb) is DAMAGED.
//   - After the library has parsed an image, its width, height and channel kind must equal what our
//     parsers read; a difference is DAMAGED (the two readers disagree about the file).
//   - A 16-bit PNG, or one the library cannot embed, is redrawn on an OffscreenCanvas as an 8-bit PNG;
//     the canvas and the bitmap are released after use.
import { EngineError } from '../errors.js';
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

// Removes every APP1 (Exif, XMP) and APP13 (IPTC) segment, wherever it sits, and copies everything else
// as it is. A segment is 0xFF, a marker, a length that counts its own two bytes, and the payload; inside
// the compressed data every 0xFF is followed by a zero or a restart marker, so a marker with a length is
// always a real segment. Each pass moves forward, so the cost is bounded by the file length.
export function stripJpegMetadata(b) {
  const len = b.length;
  const kept = [];
  let from = 0;
  let i = 2;
  while (i < len) {
    if (b[i] !== 0xff) { i += 1; continue; }
    let j = i + 1;
    while (j < len && b[j] === 0xff) j += 1; // fill bytes
    if (j + 2 >= len) break; // no room for a marker and its length
    const marker = b[j];
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i = j + 1; continue; }
    const size = (b[j + 1] << 8) | b[j + 2];
    if (size < 2 || j + 1 + size > len) { i = j + 1; continue; }
    const end = j + 1 + size;
    if (marker === 0xe1 || marker === 0xed) {
      kept.push(b.subarray(from, i));
      from = end;
    }
    i = end;
  }
  if (kept.length === 0) return b;
  kept.push(b.subarray(from));
  const out = new Uint8Array(kept.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of kept) { out.set(p, at); at += p.length; }
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
    if (err instanceof RangeError) throw err;
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

// Inflates a zlib stream given in pieces and only counts the output; nothing is kept. The count is
// checked on every chunk the decompressor produces and the stream is cancelled the moment it passes the
// cap, so the work and the memory are bounded by the cap plus one chunk, not by the stream.
// DecompressionStream is native in workers (and in Node), so no code is added to the engine.
// Returns { ok, size, over }: ok means the stream ended cleanly inside the cap.
export async function inflateCapped(parts, cap) {
  if (typeof DecompressionStream !== 'function') throw new EngineError('INTERNAL');
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const feed = (async () => {
    try {
      for (const part of parts) await writer.write(part);
      await writer.close();
    } catch { /* the reader reports the failure, or the cancel below ended the stream */ }
  })();
  let size = 0;
  let over = false;
  let ok = false;
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
  const idat = [];
  let idatEnded = false;
  let at = 8;
  while (at + 12 <= b.length) {
    const size = u32(b, at);
    const type = typeAt(b, at + 4);
    if (type === 'IHDR' && ihdr === null) {
      ihdr = chunkBytes(b, at, size);
    } else if (type === 'IDAT') {
      if (idatEnded) throw new EngineError('DAMAGED'); // image data split by another chunk
      idat.push(chunkBytes(b, at, size));
    } else {
      if (idat.length > 0) idatEnded = true;
      if (idat.length === 0 && type === 'PLTE' && indexed && plte === null) plte = chunkBytes(b, at, size);
      else if (idat.length === 0 && type === 'tRNS' && trns === null) trns = chunkBytes(b, at, size);
    }
    if (type === 'IEND') break;
    at += 12 + size;
  }
  if (ihdr === null || idat.length === 0) throw new EngineError('DAMAGED');
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
  // The image data: inflated here, once, against the cap taken from the header.
  const parts = idat.map((c) => c.subarray(8, c.length - 4));
  const cap = expectedRawSize(info);
  const inflated = await inflateCapped(parts, cap);
  if (!inflated.ok || inflated.size !== cap) throw new EngineError('DAMAGED');
  const list = [Uint8Array.from(PNG_SIGNATURE), ihdr, ...(plte ? [plte] : []), ...(trns ? [trns] : []), ...idat, IEND_CHUNK];
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
    if (err instanceof EngineError || err instanceof RangeError) throw err;
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
      if (err instanceof EngineError || err instanceof RangeError) throw err;
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
      if (err instanceof EngineError || err instanceof RangeError) throw err;
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
      if (err instanceof RangeError) throw new EngineError('TOO_LARGE', index);
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
