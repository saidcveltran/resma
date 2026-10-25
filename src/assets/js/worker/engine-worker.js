// C7 engine worker: the only entry point is the op map below (boundary B2). Anything that is not
// an own key of the map gets an INTERNAL error and runs no code.
import { toErrorReply } from './errors.js';

const VENDOR_URL = new URL('../../vendor/pdf-lib.esm.min.js', import.meta.url).href;

// The op map: null prototype, own keys only, frozen once the engine has loaded. It is the worker's
// only entry point and holds exactly these ops.
export const opMap = Object.create(null);
let failed = false;

// Loaded with import() inside try/catch so that a failed start is reported, not silent.
const started = (async () => {
  try {
    const [lib, inspect, merge, images] = await Promise.all([
      import(VENDOR_URL), import('./ops/inspect.js'), import('./ops/merge.js'), import('./ops/images.js'),
    ]);
    if (typeof lib.PDFDocument?.create !== 'function') throw new Error('engine-missing');
    opMap.inspect = (m) => inspect.run(m, lib);
    opMap.merge = (m, progress) => merge.run(m, lib, progress);
    opMap.images = (m, progress) => images.run(m, lib, progress, globalThis);
    opMap.ping = async () => ({ pages: 0 });
    Object.freeze(opMap);
    self.postMessage({ type: 'ready' });
  } catch {
    failed = true;
    self.postMessage({ type: 'error', code: 'INTERNAL' });
  }
})();

self.onmessage = async (ev) => {
  const m = ev.data;
  const isObject = m !== null && typeof m === 'object';
  const id = isObject && Number.isSafeInteger(m.id) ? m.id : undefined;
  try {
    await started;
    const name = isObject ? m.op : undefined;
    if (failed || typeof name !== 'string' || !Object.hasOwn(opMap, name)) {
      self.postMessage({ id, type: 'error', code: 'INTERNAL' });
      return;
    }
    const out = await opMap[name](m, (done, total) => {
      self.postMessage({ id, type: 'progress', done, total });
    });
    const reply = { id, type: 'result', pages: out.pages };
    if (out.bytes instanceof Uint8Array) {
      const exact = out.bytes.byteOffset === 0 && out.bytes.buffer.byteLength === out.bytes.length;
      reply.bytes = exact ? out.bytes.buffer : out.bytes.slice().buffer;
      self.postMessage(reply, [reply.bytes]);
    } else {
      self.postMessage(reply);
    }
  } catch (err) {
    self.postMessage(toErrorReply(id, err));
  }
};
