// Builds the name of the downloaded PDF from the first file's name (DESIGN 6.5, SA-6). The result
// is a plain string for the download attribute; it is never inserted as HTML anywhere.
import {
  OUTPUT_NAME_MAX, OUTPUT_EXTENSION, OUTPUT_SUFFIX_MERGE, OUTPUT_SUFFIX_IMAGES,
  OUTPUT_FALLBACK_MERGE, OUTPUT_FALLBACK_IMAGES, KNOWN_INPUT_EXTENSIONS,
} from './config.js';

// C0 and C1 controls, bidi controls (LRM, RLM, ALM, embeddings/overrides, isolates), line and
// paragraph separators, BOM, lone surrogates, and the characters Windows and URLs reject.
const REMOVED = new RegExp(
  '[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff'
  + '\\\\/:*?"<>|]'
  + '|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]',
  'g',
);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const EDGES = /^[.\s]+|[.\s]+$/g;

function stripExtension(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return name;
  const ext = name.slice(dot + 1).toLowerCase();
  return KNOWN_INPUT_EXTENSIONS.includes(ext) ? name.slice(0, dot) : name;
}

function clean(text) {
  return text.replace(REMOVED, '').replace(/\s+/g, ' ').replace(EDGES, '');
}

// Keeps at most `limit` UTF-16 units without cutting a surrogate pair.
function cut(text, limit) {
  if (text.length <= limit) return text;
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

// outputName('merge' | 'images', firstFileName, imageCount) -> file name ending in .pdf, <= 80 units.
export function outputName(mode, firstName, count = 1) {
  const merge = mode === 'merge';
  const suffix = merge ? OUTPUT_SUFFIX_MERGE : (count > 1 ? OUTPUT_SUFFIX_IMAGES : '');
  const fallback = merge ? OUTPUT_FALLBACK_MERGE : OUTPUT_FALLBACK_IMAGES;
  const raw = typeof firstName === 'string' ? firstName : '';
  // Remove the input extension on the raw name, so "a.b.pdf" keeps "a.b" and ".pdf" alone is empty.
  let base = clean(stripExtension(raw.replace(REMOVED, '').replace(/\s+/g, ' ').trim()));
  base = clean(cut(base, OUTPUT_NAME_MAX - suffix.length - OUTPUT_EXTENSION.length));
  if (base === '') return fallback;
  // A DOS device name (CON, NUL, COM1...) before the first dot is reserved on Windows.
  if (RESERVED.test((base + suffix).split('.')[0].trim())) base = `_${base}`;
  return `${base}${suffix}${OUTPUT_EXTENSION}`;
}
