// Classifies a file by the magic bytes of its first SNIFF_BYTES bytes (DESIGN 6.7, C5). The file
// name and the type the OS reports are never consulted: they are attacker-controlled labels.
import { SNIFF_BYTES } from './config.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HEIC_BRANDS = new Set(['heic', 'heix', 'mif1', 'heif']);
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

// Classifies an already-read head (never more than SNIFF_BYTES of it is looked at).
export function sniffBytes(input) {
  const head = input.length > SNIFF_BYTES ? input.subarray(0, SNIFF_BYTES) : input;
  // Fixed-offset formats first: a file that starts as an image is an image even if "%PDF-"
  // appears later in a comment or metadata segment.
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, PNG_SIGNATURE)) return 'png';
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    return HEIC_BRANDS.has(ascii(head, 8, 12)) ? 'heic' : 'other';
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
