// C4 status: one polite role="status" region, one role="alert" region and a progress bar per tool.
// Progress text (and the bar with it) is throttled (at most one change per STATUS_THROTTLE_MS); every
// other message is written at once. Texts are set as text nodes only. Both regions are marked
// translate="no" because messages can contain a file name (CS-7).
import { t } from './strings.es.js';
import { STATUS_THROTTLE_MS } from './config.js';
import { icon } from './icons.js';

// A raw file name inside a sentence: isolate controls are removed from the name, then the name is
// wrapped in FSI ... PDI, so a U+202E in it cannot reorder the text that follows (SEC-2).
export function isolate(name) {
  return name ? `\u2068${String(name).replace(/[\u2066-\u2069]/g, '')}\u2069` : '';
}

// An error message in the alert region: the warning icon (decorative) and the text.
export function showAlert(alertEl, text) {
  alertEl.replaceChildren(icon('alert'), document.createTextNode(text));
}

export function createStatus(statusEl, alertEl, progressEl = null) {
  let lastWrite = -Infinity;
  let timer = 0;
  let pending = null;
  statusEl.setAttribute('translate', 'no');
  alertEl.setAttribute('translate', 'no');

  function write(text, done, total) {
    lastWrite = Date.now();
    statusEl.textContent = text;
    if (progressEl && total > 0) {
      progressEl.max = total;
      progressEl.value = done;
    }
  }

  function hideBar() {
    if (progressEl) progressEl.hidden = true;
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
      hideBar();
      write(text);
    },
    // A job has started: the bar shows at 0 of `total` until the first progress message.
    start(total) {
      if (!progressEl) return;
      progressEl.max = total;
      progressEl.value = 0;
      progressEl.hidden = false;
    },
    // "Procesando archivo 3 de 10…": the first one shows at once, later ones at most once per interval;
    // the newest text wins.
    progress(done, total) {
      const text = t('status.progress', { done, total });
      const wait = lastWrite + STATUS_THROTTLE_MS - Date.now();
      if (progressEl) progressEl.hidden = false;
      if (wait <= 0) {
        cancelPending();
        write(text, done, total);
        return;
      }
      pending = { text, done, total };
      if (!timer) {
        timer = setTimeout(() => {
          timer = 0;
          const next = pending;
          pending = null;
          if (next !== null) write(next.text, next.done, next.total);
        }, wait);
      }
    },
    // Error text in the alert region. The caller decides about focus (see focusAlert).
    error(text) {
      cancelPending();
      hideBar();
      showAlert(alertEl, text);
    },
    clearError() {
      alertEl.textContent = '';
    },
    focusAlert() {
      alertEl.focus();
    },
    clear() {
      cancelPending();
      hideBar();
      statusEl.textContent = '';
      alertEl.textContent = '';
    },
  };
}
