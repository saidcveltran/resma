// Builds the name of the downloaded PDF from the first file's name (DESIGN 6.5, SA-6). The result
// is a plain string for the download attribute; it is never inserted as HTML anywhere.
import {
  OUTPUT_NAME_MAX, OUTPUT_EXTENSION, OUTPUT_SUFFIX_MERGE, OUTPUT_SUFFIX_IMAGES,
  OUTPUT_FALLBACK_MERGE, OUTPUT_FALLBACK_IMAGES, KNOWN_INPUT_EXTENSIONS,
} from './config.js';

// Everything invisible or dangerous in a name: controls (Cc), format characters such as zero-width
// and bidi controls (Cf), lone surrogates (Cs, in u mode it matches only unpaired ones), line and
// paragraph separators, default-ignorable code points (soft hyphen, U+180E, variation selectors,
// tag characters, fillers), and the characters Windows and URLs reject. No normalisation is applied
// anywhere: NFKC would turn fullwidth lookalikes into real separators.
const REMOVED = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\\\/:*?"<>|]/gu;
// DOS device names, also COM0/LPT0, superscript digits 1-3, CONIN$ and CONOUT$.
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;
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
  const whole = clean(stripExtension(raw.replace(REMOVED, '').replace(/\s+/g, ' ').trim()));
  const room = OUTPUT_NAME_MAX - suffix.length - OUTPUT_EXTENSION.length;
  // `whole` holds no removable character, so cutting it cannot create a new one except a lone
  // surrogate, which the clean after the cut removes. A DOS device name (CON, NUL, COM1...) before
  // the first dot is reserved on Windows: it gets a "_" prefix, whose unit is reserved before the cut.
  let base = clean(cut(whole, room));
  if (base === '') return fallback;
  if (RESERVED.test((base + suffix).split('.')[0].trim())) {
    base = clean(cut(whole, room - 1));
    if (base === '') return fallback;
    base = `_${base}`;
  }
  return `${base}${suffix}${OUTPUT_EXTENSION}`;
}
