// Error codes the worker may send to the page (DESIGN 6.3). Anything else becomes INTERNAL.
export const CODES = Object.freeze([
  'WRONG_TYPE', 'PROTECTED', 'DAMAGED', 'TOO_LARGE', 'IMAGE_TOO_BIG', 'IMAGE_UNSUPPORTED', 'INTERNAL',
]);

// Any value that is not exactly one of the codes above is INTERNAL (never looked up by name).
export const safeCode = (code) => (typeof code === 'string' && CODES.includes(code) ? code : 'INTERNAL');
// A file index is a non-negative integer or nothing.
export const safeIndex = (index) => (Number.isSafeInteger(index) && index >= 0 ? index : undefined);

export class EngineError extends Error {
  constructor(code, index) {
    super(code);
    this.name = 'EngineError';
    this.code = safeCode(code);
    if (safeIndex(index) !== undefined) this.index = index;
  }
}

// The reply for any failure. Only the code (and the file index) leaves the worker, never a message,
// a stack or file content.
export function toErrorReply(id, err) {
  let code = 'INTERNAL';
  let index;
  if (err instanceof EngineError) {
    code = err.code;
    index = err.index;
  } else if (err instanceof RangeError) {
    code = 'TOO_LARGE'; // out of memory while parsing or saving (DESIGN 6.7)
  }
  const reply = { id, type: 'error', code };
  if (index !== undefined) reply.index = index;
  return reply;
}
