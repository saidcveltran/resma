// Op `inspect`: count the pages of one PDF, or say why it cannot be used.
// The library recovers silently from several kinds of damage, so the checks here are our own.
import { EngineError, isResourceError } from '../errors.js';
import { checkParseBudget } from '../budget.js';

const EOF_WINDOW = 1024; // the end-of-file marker must sit in the last 1,024 bytes
const KNOWN_FILTERS = new Set(['Standard']);
// Public-key (certificate) handlers: a file locked this way needs a key we do not have.
const CERTIFICATE_FILTERS = new Set(['Adobe.PubSec', 'Adobe.PPKLite', 'Adobe.PPKMS', 'Entrust.PPKEF']);
const EOF_MARKER = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF

export function hasEofMarker(bytes) {
  const start = Math.max(0, bytes.length - EOF_WINDOW);
  for (let i = bytes.length - EOF_MARKER.length; i >= start; i--) {
    let hit = true;
    for (let j = 0; j < EOF_MARKER.length; j++) {
      if (bytes[i + j] !== EOF_MARKER[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

function hasBytes(bytes, needle) {
  const first = needle.charCodeAt(0);
  outer: for (let i = bytes.indexOf(first); i !== -1 && i <= bytes.length - needle.length; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

// The library cannot open public-key encryption and fails with a generic error; the handler's name sits
// in the clear in the /Encrypt dictionary (which is never inside an object stream).
function isCertificateLocked(bytes) {
  return hasBytes(bytes, '/Encrypt') && [...CERTIFICATE_FILTERS].some((name) => hasBytes(bytes, `/${name}`));
}

// Validates the message shape (boundary B2) and returns the files as [{index, bytes: Uint8Array}].
export function readFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new EngineError('INTERNAL');
  return files.map((f, i) => {
    if (f === null || typeof f !== 'object' || !(f.bytes instanceof ArrayBuffer)) {
      throw new EngineError('INTERNAL', i);
    }
    return { index: Number.isSafeInteger(f.index) ? f.index : i, bytes: new Uint8Array(f.bytes) };
  });
}

// The library counts pages by recursion, so a page tree that lists itself ends in a stack overflow, which looks like a
// resource limit. Walk /Kids ourselves, without recursion: a node reached again from itself is a cycle (DAMAGED, in
// milliseconds), and more visits than the file has bytes cannot be an honest tree. A tree that is merely very deep passes
// this walk and still overflows the library's own recursion: that stays TOO_LARGE.
function checkPageTree(lib, doc, budget) {
  const { PDFDict, PDFArray, PDFRef, PDFName } = lib;
  const ctx = doc.context;
  const onPath = new Set();
  const stack = [{ v: doc.catalog.get(PDFName.of('Pages')) }];
  let visits = 0;
  while (stack.length > 0) {
    const { v, leave } = stack.pop();
    if (leave) { onPath.delete(v); continue; }
    if (!(v instanceof PDFRef)) continue;
    if (onPath.has(v.tag) || ++visits > budget) return false;
    const node = ctx.lookup(v);
    const kids = node instanceof PDFDict ? node.lookup(PDFName.of('Kids')) : undefined;
    if (!(kids instanceof PDFArray)) continue;
    onPath.add(v.tag);
    stack.push({ v: v.tag, leave: true });
    for (let i = kids.size() - 1; i >= 0; i--) stack.push({ v: kids.get(i) });
  }
  return true;
}

// Loads one PDF and applies the damage checks. Returns the document.
// Owner-restricted files open with the empty password and are used; files that need a password
// to open are PROTECTED. `ignoreEncryption` is never used: it yields undecrypted pages.
export async function loadPdf(lib, bytes, index) {
  const { PDFDocument, PDFName, PDFDict, PDFNumber } = lib;
  if (!hasEofMarker(bytes)) throw new EngineError('DAMAGED', index);
  await checkParseBudget(bytes, index);
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { password: '', updateMetadata: false });
  } catch (err) {
    if (isResourceError(err)) throw new EngineError('TOO_LARGE', index);
    const text = err && typeof err.message === 'string' ? err.message : '';
    if (/NEEDS PASSWORD|Password incorrect|is encrypted/i.test(text)) throw new EngineError('PROTECTED', index);
    if (isCertificateLocked(bytes)) throw new EngineError('PROTECTED', index);
    throw new EngineError('DAMAGED', index);
  }
  try {
    // A decrypted file no longer has /Encrypt in the trailer. If it is still there, it must be a
    // dictionary with a known /Filter; a dangling reference is a damaged file.
    const encrypt = doc.context.trailerInfo.Encrypt;
    if (encrypt !== undefined) {
      const dict = doc.context.lookup(encrypt);
      const filter = dict instanceof PDFDict ? dict.lookup(PDFName.of('Filter')) : undefined;
      const name = filter instanceof PDFName ? filter.decodeText() : '';
      if (CERTIFICATE_FILTERS.has(name)) throw new EngineError('PROTECTED', index);
      if (!KNOWN_FILTERS.has(name)) throw new EngineError('DAMAGED', index);
    }
    // The page tree's own count must equal the pages the recovery found.
    const root = doc.catalog.lookup(PDFName.of('Pages'), PDFDict);
    if (!checkPageTree(lib, doc, bytes.length)) throw new EngineError('DAMAGED', index);
    const count = root.lookup(PDFName.of('Count'));
    const pages = doc.getPageCount();
    if (!(count instanceof PDFNumber) || count.asNumber() !== pages || pages < 1) {
      throw new EngineError('DAMAGED', index);
    }
  } catch (err) {
    if (err instanceof EngineError) throw err;
    throw new EngineError(isResourceError(err) ? 'TOO_LARGE' : 'DAMAGED', index);
  }
  return doc;
}

export async function run({ files }, lib) {
  const [file, ...rest] = readFiles(files);
  if (rest.length > 0) throw new EngineError('INTERNAL'); // one file per inspect call
  const doc = await loadPdf(lib, file.bytes, file.index);
  return { pages: doc.getPageCount() };
}
