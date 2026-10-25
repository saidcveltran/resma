// C4 status: one polite role="status" region and one role="alert" region per tool. Progress text is
// throttled (at most one change per STATUS_THROTTLE_MS); every other message is written at once.
// Texts are set with textContent only. Both regions are marked translate="no" because messages
// can contain a file name (CS-7).
import { t } from './strings.es.js';
import { STATUS_THROTTLE_MS } from './config.js';

// A raw file name inside a sentence: isolate controls are removed from the name, then the name is
// wrapped in FSI ... PDI, so a U+202E in it cannot reorder the text that follows (SEC-2).
export function isolate(name) {
  return name ? `\u2068${String(name).replace(/[\u2066-\u2069]/g, '')}\u2069` : '';
}

export function createStatus(statusEl, alertEl) {
  let lastWrite = -Infinity;
  let timer = 0;
  let pending = null;
  statusEl.setAttribute('translate', 'no');
  alertEl.setAttribute('translate', 'no');

  function write(text) {
    lastWrite = Date.now();
    statusEl.textContent = text;
  }

  function cancelPending() {
    if (timer) clearTimeout(timer);
    timer = 0;
    pending = null;
  }

  return {
    // Immediate message; any waiting progress text is dropped (it would be stale).
    info(text) {
      cancelPending();
      write(text);
    },
    // "Procesando archivo 3 de 10…": the first one shows at once, later ones at most once per interval;
    // the newest text wins.
    progress(done, total) {
      const text = t('status.progress', { done, total });
      const wait = lastWrite + STATUS_THROTTLE_MS - Date.now();
      if (wait <= 0) {
        cancelPending();
        write(text);
        return;
      }
      pending = text;
      if (!timer) {
        timer = setTimeout(() => {
          timer = 0;
          const next = pending;
          pending = null;
          if (next !== null) write(next);
        }, wait);
      }
    },
    // Error text in the alert region. The caller decides about focus (see focusAlert).
    error(text) {
      alertEl.textContent = text;
    },
    clearError() {
      alertEl.textContent = '';
    },
    focusAlert() {
      alertEl.focus();
    },
    clear() {
      cancelPending();
      statusEl.textContent = '';
      alertEl.textContent = '';
    },
  };
}
