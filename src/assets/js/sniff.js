// Classifies a file by the magic bytes of its first SNIFF_BYTES bytes (DESIGN 6.7, C5). The file
// name and the type the OS reports are never consulted: they are attacker-controlled labels.
import { SNIFF_BYTES } from './config.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// HEIF family brands (case-insensitive, as some writers use capitals): still images and sequences in HEVC.
const HEIC_BRANDS = new Set(['heic', 'heix', 'mif1', 'heif', 'msf1', 'hevc', 'heim', 'heis', 'hevx']);
const PDF_MARK = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function ascii(bytes, from, to) {
  let s = '';
  for (let i = from; i < to; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

function startsWith(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

// An ftyp box names a major brand and then lists compatible brands up to the end of the box (its size field is
// clamped to the head that was read). It is HEIC when the major brand or any listed brand is in the HEIF family.
function isHeicBox(head) {
  const brandAt = (at) => ascii(head, at, at + 4).toLowerCase();
  if (HEIC_BRANDS.has(brandAt(8))) return true;
  const size = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
  const end = Math.min(size, head.length);
  for (let at = 16; at + 4 <= end; at += 4) {
    if (HEIC_BRANDS.has(brandAt(at))) return true;
  }
  return false;
}

// Classifies an already-read head (never more than SNIFF_BYTES of it is looked at).
export function sniffBytes(input) {
  const head = input.length > SNIFF_BYTES ? input.subarray(0, SNIFF_BYTES) : input;
  // Fixed-offset formats first: a file that starts as an image is an image even if "%PDF-"
  // appears later in a comment or metadata segment.
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, PNG_SIGNATURE)) return 'png';
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    return isHeicBox(head) ? 'heic' : 'other';
  }
  // A PDF may have some bytes before the header; the mark may sit anywhere in the window.
  for (let i = 0; i + PDF_MARK.length <= head.length; i += 1) {
    if (startsWith(head, PDF_MARK, i)) return 'pdf';
  }
  return 'other';
}

// sniff(file) -> 'pdf' | 'jpeg' | 'png' | 'heic' | 'other'. Accepts a File or Blob (read with
// slice(0, SNIFF_BYTES)) or bytes already in memory. Anything unreadable is 'other'.
export async function sniff(file) {
  try {
    if (file && typeof file.slice === 'function' && typeof file.arrayBuffer === 'function') {
      const buffer = await file.slice(0, SNIFF_BYTES).arrayBuffer();
      return sniffBytes(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, SNIFF_BYTES)));
    }
    if (ArrayBuffer.isView(file)) {
      return sniffBytes(new Uint8Array(file.buffer, file.byteOffset, Math.min(file.byteLength, SNIFF_BYTES)));
    }
    if (file instanceof ArrayBuffer) {
      return sniffBytes(new Uint8Array(file, 0, Math.min(file.byteLength, SNIFF_BYTES)));
    }
  } catch {
    return 'other';
  }
  return 'other';
}
