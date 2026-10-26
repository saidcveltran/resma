// Parse-time budget (DESIGN 21: T8, T11, SA-7). The library decodes every object stream and cross-reference stream in full
// and builds every string one character at a time, so a small file can ask for gigabytes. The budget is enforced on the bytes
// the library really decodes: at run time, from our own code, the two parser factories it calls for those streams are
// replaced by guarded ones (the vendored file is not touched). Each guard decodes the stream first with a byte cap, using the
// library's own decoder, so a stream is never fully materialised past the cap; then it checks the header and, for an object
// stream, meters how many bytes the library walks to parse each object. A cap passed is remembered on the load in progress
// (the library swallows errors thrown while it parses an object) and withParseBudget() turns it into TOO_LARGE.
// Content and image streams are never decoded by the parser and are not counted.
import { EngineError } from './errors.js';
import { PARSE_STREAM_MAX_BYTES, PARSE_FILE_MAX_BYTES, PARSE_TOKEN_MAX_BYTES, PARSE_OBJECTS_MAX, PARSE_FILTERS_MAX } from '../config.js';

export const DEFAULT_LIMITS = Object.freeze({
  streamMax: PARSE_STREAM_MAX_BYTES, fileMax: PARSE_FILE_MAX_BYTES, tokenMax: PARSE_TOKEN_MAX_BYTES, objectsMax: PARSE_OBJECTS_MAX,
});
export const GUARDED = Symbol.for('resma.parseBudget');

let active = null; // the session of the load in progress

function newSession(limits) {
  return { limits, tripped: null, damaged: false, decoded: 0, objectStreams: 0, xrefStreams: 0 };
}

function trip(session, reason) {
  if (session.tripped === null) session.tripped = reason;
  throw new EngineError('TOO_LARGE');
}

const inRange = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;

// Decodes `rawStream` the way the library will (same filters, already decrypted), stopping as soon as a cap is passed.
// Returns the decoded size. A stream the library cannot decode throws here what it would throw there.
function decodedSize(lib, rawStream, session) {
  const room = Math.min(session.limits.streamMax, session.limits.fileMax - session.decoded);
  // Real files use one or two filters; a longer chain is refused before anything is decoded.
  const filter = rawStream?.dict?.lookup?.(lib.PDFName.of('Filter'));
  if (typeof filter?.size === 'function' && filter.size() > PARSE_FILTERS_MAX) {
    session.damaged = true; // remembered like a cap: the library may swallow the error
    throw new EngineError('DAMAGED');
  }
  const stream = lib.decodePDFRawStream(rawStream);
  // Every decoder of the chain asks for its buffer before it writes past it: refuse the growth beyond the cap. The walk has
  // no hop limit (it ends when there is no inner stream); a visited set stops a cycle.
  const seen = new Set();
  for (let s = stream; s !== null && typeof s === 'object' && !seen.has(s); s = s.stream ?? s.str) {
    seen.add(s);
    if (typeof s.ensureBuffer !== 'function') continue;
    const grow = s.ensureBuffer;
    s.ensureBuffer = (n) => {
      if (!(n <= room)) trip(session, 'stream');
      return grow.call(s, n);
    };
  }
  let size;
  if (typeof stream.readBlock === 'function') {
    while (!stream.eof) {
      stream.readBlock();
      if (stream.bufferLength > room) trip(session, 'stream');
    }
    size = stream.bufferLength;
  } else {
    size = stream.length;
  }
  if (!(size <= room)) trip(session, 'stream');
  session.decoded += size;
  return size;
}

function guardObjectStreams(lib, original) {
  return function forStream(rawStream, ...rest) {
    const session = active ?? newSession(DEFAULT_LIMITS);
    if (session.tripped !== null) throw new EngineError('TOO_LARGE');
    const { tokenMax, objectsMax } = session.limits;
    const size = decodedSize(lib, rawStream, session);
    session.objectStreams++;
    const parser = original.call(this, rawStream, ...rest);
    if (!inRange(parser.objectCount, objectsMax) || !inRange(parser.firstOffset, size)) trip(session, 'header');
    const readHeader = parser.parseOffsetsAndObjectNumbers;
    parser.parseOffsetsAndObjectNumbers = function parseOffsetsAndObjectNumbers() {
      const entries = readHeader.call(this);
      let previous = -1;
      for (const { offset } of entries) {
        if (!Number.isSafeInteger(offset) || offset <= previous || parser.firstOffset + offset >= size) trip(session, 'header');
        previous = offset;
      }
      return entries;
    };
    // Objects start at strictly increasing offsets, so an honest stream is walked once: no object can take more than the
    // token cap, and all of them together no more than the stream is long. The library reads every byte through
    // bytes.next(), so the walk is metered as it happens and a long string or name stops at the cap, not after it is built.
    const parseObject = parser.parseObject;
    const bytes = parser.bytes;
    const next = bytes.next;
    let depth = 0, from = 0, walked = 0;
    const over = (position) => position - from > tokenMax || walked + position - from > size;
    bytes.next = function guardedNext() {
      if (depth > 0 && over(this.idx)) trip(session, 'token');
      return next.call(this);
    };
    parser.parseObject = function guardedParseObject(...args) {
      if (depth === 0) from = this.bytes.offset();
      depth++;
      try {
        return parseObject.apply(this, args);
      } finally {
        depth--;
        if (depth === 0) {
          const used = Math.max(0, this.bytes.offset() - from);
          if (over(from + used)) trip(session, 'token');
          walked += used;
        }
      }
    };
    return parser;
  };
}

function guardXrefStreams(lib, original) {
  return function forStream(rawStream, ...rest) {
    const session = active ?? newSession(DEFAULT_LIMITS);
    if (session.tripped !== null) throw new EngineError('TOO_LARGE');
    decodedSize(lib, rawStream, session);
    session.xrefStreams++;
    const parser = original.call(this, rawStream, ...rest);
    let entries = 0;
    for (const { length } of Array.isArray(parser.subsections) ? parser.subsections : [{ length: NaN }]) entries += length;
    if (!inRange(entries, session.limits.objectsMax)) trip(session, 'header');
    return parser;
  };
}

function isGuarded(fn) {
  return typeof fn === 'function' && fn[GUARDED] === true;
}

// Installs the guards on the library's classes. Idempotent. Throws INTERNAL if the library does not offer what the guards
// need, or if a guard could not be put in place: a load must never run without the budget.
export function installParseBudget(lib) {
  const objectStreams = lib?.PDFObjectStreamParser;
  const xrefStreams = lib?.PDFXRefStreamParser;
  if (typeof objectStreams?.forStream !== 'function' || typeof xrefStreams?.forStream !== 'function'
    || typeof lib.decodePDFRawStream !== 'function' || typeof lib.PDFName?.of !== 'function') throw new EngineError('INTERNAL');
  try {
    for (const [owner, make] of [[objectStreams, guardObjectStreams], [xrefStreams, guardXrefStreams]]) {
      if (isGuarded(owner.forStream)) continue;
      const guarded = make(lib, owner.forStream);
      Object.defineProperty(guarded, GUARDED, { value: true });
      owner.forStream = guarded;
    }
  } catch {
    throw new EngineError('INTERNAL');
  }
  if (!isGuarded(objectStreams.forStream) || !isGuarded(xrefStreams.forStream)) throw new EngineError('INTERNAL');
}

// Runs `work` (a library load) under the budget. Resolves to { value, usage }. A cap passed anywhere in the load is
// TOO_LARGE with the file index, and a /Filter chain past the limit is DAMAGED with it, whatever else the library did. Loads do not overlap.
export async function withParseBudget(lib, work, index, limits = DEFAULT_LIMITS) {
  installParseBudget(lib);
  if (active !== null) throw new EngineError('INTERNAL', index);
  const session = newSession(limits);
  active = session;
  let value, error, failed = false;
  try {
    value = await work();
  } catch (err) {
    failed = true;
    error = err;
  } finally {
    active = null;
  }
  if (session.tripped !== null) throw new EngineError('TOO_LARGE', index);
  if (session.damaged) throw new EngineError('DAMAGED', index);
  if (failed) throw error;
  const { decoded, objectStreams, xrefStreams } = session;
  return { value, usage: { decoded, objectStreams, xrefStreams } };
}
