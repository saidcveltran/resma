// Parse-time budget (DESIGN 21: T8, T11, SA-7). Before the library parses a PDF it decodes object streams and
// cross-reference streams in full, and builds every string one character at a time, so a small file can ask for
// gigabytes. This module looks at those streams first, from our code and without touching the library: it inflates each
// one with a byte cap (stopping as soon as a cap is passed) and measures the string and name tokens inside object streams.
// Content and image streams are never decoded by the parser or by this module, and are not counted.
import { EngineError } from './errors.js';
import { PARSE_STREAM_MAX_BYTES, PARSE_FILE_MAX_BYTES, PARSE_TOKEN_MAX_BYTES } from '../config.js';

const DEFAULT_LIMITS = Object.freeze({
  streamMax: PARSE_STREAM_MAX_BYTES, fileMax: PARSE_FILE_MAX_BYTES, tokenMax: PARSE_TOKEN_MAX_BYTES,
});
const DICT_WINDOW = new TextDecoder('latin1');
const FEED = 4096; // compressed bytes handed to the inflater per write
const PIECE = 65536; // an unfiltered stream is fed to the token reader in pieces of this size

const isSpace = (b) => b === 32 || b === 9 || b === 10 || b === 13 || b === 12 || b === 0;
const isDelimiter = (b) => b === 40 || b === 41 || b === 60 || b === 62 || b === 91 || b === 93 || b === 123 || b === 125
  || b === 47 || b === 37;

function at(bytes, pos, word) {
  if (pos < 0 || pos + word.length > bytes.length) return false;
  for (let i = 0; i < word.length; i++) if (bytes[pos + i] !== word.charCodeAt(i)) return false;
  return true;
}

function indexOfWord(bytes, word, from) {
  const first = word.charCodeAt(0);
  for (let i = bytes.indexOf(first, from); i !== -1; i = bytes.indexOf(first, i + 1)) {
    if (at(bytes, i, word)) return i;
  }
  return -1;
}

// The next "stream" keyword at or after `from`: preceded by ">>" (blanks allowed), not part of "endstream", and followed
// by the end of a line. Returns its position, or -1.
function nextStreamKeyword(bytes, from) {
  for (let i = indexOfWord(bytes, 'stream', from); i !== -1; i = indexOfWord(bytes, 'stream', i + 1)) {
    if (i >= 3 && at(bytes, i - 3, 'end')) continue;
    const after = bytes[i + 6];
    if (after !== 10 && after !== 13) continue;
    let p = i - 1;
    while (p >= 0 && isSpace(bytes[p])) p--;
    if (p >= 1 && bytes[p] === 62 && bytes[p - 1] === 62) return i;
  }
  return -1;
}

// Text of the dictionary that ends at `keyword`: from the "obj" before it (not below `floor`) to the keyword. Names are
// returned with their # escapes resolved, so /Obj#53tm is read as /ObjStm.
function dictionaryBefore(bytes, keyword, floor) {
  let start = floor;
  for (let j = keyword - 3; j >= floor; j--) {
    if (bytes[j] === 111 && bytes[j + 1] === 98 && bytes[j + 2] === 106 && j > 0 && bytes[j - 1] !== 100) { start = j + 3; break; }
  }
  return DICT_WINDOW.decode(bytes.subarray(start, keyword))
    .replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Where the stream data ends: the direct /Length when "endstream" follows it, else the next "endstream".
function dataEnd(bytes, dict, start) {
  const m = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/.exec(dict);
  if (m) {
    const end = start + Number(m[1]);
    if (end <= bytes.length) {
      let p = end;
      while (p < bytes.length && isSpace(bytes[p])) p++;
      if (at(bytes, p, 'endstream')) return { end, next: p + 9 };
    }
  }
  const found = indexOfWord(bytes, 'endstream', start);
  if (found === -1) return { end: bytes.length, next: bytes.length };
  let end = found;
  if (end > start && bytes[end - 1] === 10) end--;
  if (end > start && bytes[end - 1] === 13) end--;
  return { end, next: found + 9 };
}

// What the parser decodes: an object stream (tokens are measured) or a cross-reference stream (bytes are only counted).
function kindOf(dict) {
  const m = /\/Type\s*\/(ObjStm|XRef)(?![^\s/<>[\]()%])/.exec(dict);
  return m ? m[1] : null;
}

// 'none', 'flate', or 'other' (a chain this module cannot bound).
function filterOf(dict) {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[^\s/<>[\]()%]+)/.exec(dict);
  if (!m) return 'none';
  const names = [...m[1].matchAll(/\/([^\s/<>[\]()%]+)/g)].map((x) => x[1]);
  return names.length === 1 && (names[0] === 'FlateDecode' || names[0] === 'Fl') ? 'flate' : 'other';
}

// Inflated chunks of one zlib stream. The compressed bytes go in a few KB at a time, and no more are written once the
// caller stops asking, so a reader that inflates a whole input chunk at once (WebKit) still produces only a few MB per
// step: deflate cannot expand more than about 1,000 to 1. A stream that is corrupt (or encrypted: then it is not zlib
// data) simply ends: the parser deals with it.
async function* inflated(data) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  let stopped = false;
  (async () => {
    for (let i = 0; i < data.length && !stopped; i += FEED) await writer.write(data.slice(i, i + FEED));
    if (!stopped) await writer.close();
  })().catch(() => {});
  try {
    for (;;) {
      let step;
      try { step = await reader.read(); } catch { return; }
      if (step.done) return;
      yield step.value;
    }
  } finally {
    stopped = true;
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
  }
}

async function* pieces(data) {
  for (let i = 0; i < data.length; i += PIECE) yield data.subarray(i, i + PIECE);
}

// A reader of PDF syntax that only measures strings and names, chunk after chunk. feed() returns true as soon as one
// token is longer than `max` (hex digits count, not bytes).
function tokenMeter(max) {
  const N = 0, STR = 1, HEX = 2, NAME = 3, COMMENT = 4;
  let state = N, depth = 0, escaped = false, len = 0, lt = false;
  return function feed(chunk) {
    for (let k = 0; k < chunk.length; k++) {
      const c = chunk[k];
      if (state === N && lt && c !== 60) { state = HEX; len = 0; lt = false; }
      if (state === N) {
        if (c === 40) { state = STR; depth = 1; escaped = false; len = 0; } else if (c === 60) lt = !lt;
        else if (c === 47) { state = NAME; len = 0; } else if (c === 37) state = COMMENT;
      } else if (state === STR) {
        if (escaped) { escaped = false; len++; } else if (c === 92) escaped = true;
        else if (c === 40) { depth++; len++; } else if (c === 41) { if (--depth === 0) state = N; else len++; } else len++;
      } else if (state === HEX) {
        if (c === 62) state = N; else if (!isSpace(c)) len++;
      } else if (state === NAME) {
        if (isSpace(c) || isDelimiter(c)) {
          state = N;
          if (c === 40) { state = STR; depth = 1; escaped = false; len = 0; } else if (c === 60) lt = true;
          else if (c === 47) { state = NAME; len = 0; } else if (c === 37) state = COMMENT;
        } else len++;
      } else if (c === 10 || c === 13) state = N;
      if (len > max) return true;
    }
    return false;
  };
}

// Looks at every object stream and cross-reference stream of the file. Resolves to
// { ok: true, inflated, streams } or { ok: false, reason: 'stream' | 'file' | 'token' | 'filter', inflated, streams };
// `inflated` is the number of bytes read so far, which is at most one chunk past a cap that was passed.
export async function scanParseBudget(bytes, limits = DEFAULT_LIMITS) {
  const { streamMax, fileMax, tokenMax } = limits;
  let total = 0, streams = 0, floor = 0, from = 0;
  const stop = (reason) => ({ ok: false, reason, inflated: total, streams });
  for (;;) {
    const keyword = nextStreamKeyword(bytes, from);
    if (keyword === -1) return { ok: true, inflated: total, streams };
    const dict = dictionaryBefore(bytes, keyword, floor);
    let start = keyword + 6;
    if (bytes[start] === 13 && bytes[start + 1] === 10) start += 2; else start += 1;
    const { end, next } = dataEnd(bytes, dict, start);
    floor = next;
    from = next;
    const kind = kindOf(dict);
    if (kind === null) continue;
    const filter = filterOf(dict);
    if (filter === 'other') return stop('filter');
    streams++;
    const data = bytes.subarray(start, Math.max(start, end));
    const meter = kind === 'ObjStm' ? tokenMeter(tokenMax) : null;
    let own = 0;
    for await (const chunk of filter === 'flate' ? inflated(data) : pieces(data)) {
      own += chunk.length;
      total += chunk.length;
      if (own > streamMax) return stop('stream');
      if (total > fileMax) return stop('file');
      if (meter && meter(chunk)) return stop('token');
    }
  }
}

// Throws EngineError TOO_LARGE for a cap that was passed, and DAMAGED for a stream whose filters cannot be bounded.
export async function checkParseBudget(bytes, index, limits = DEFAULT_LIMITS) {
  const r = await scanParseBudget(bytes, limits);
  if (!r.ok) throw new EngineError(r.reason === 'filter' ? 'DAMAGED' : 'TOO_LARGE', index);
  return r;
}
