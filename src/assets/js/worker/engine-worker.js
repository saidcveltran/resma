// C7 engine worker (shell version): loads the vendored pdf-lib and posts ready. The op map comes later.
import { PDFDocument } from '../../vendor/pdf-lib.esm.min.js';

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.op === 'ping') {
    self.postMessage({ id: m.id, type: 'result', pages: 0 });
  } else {
    self.postMessage({ id: m.id, type: 'error', code: 'INTERNAL' });
  }
};

if (typeof PDFDocument.create === 'function') self.postMessage({ type: 'ready' });
