// C1 page shell: fills the texts from strings.es.js, checks the browser, prefetches the engine.
import { t } from './strings.es.js';
import { engine } from './engine-client.js';
import { IDLE_FALLBACK_MS } from './config.js';

const root = document.documentElement;
const STATE_KEY = { preparing: 'engine.preparing', ready: 'engine.ready', failed: 'engine.failed' };

function fillStrings() {
  for (const el of document.querySelectorAll('[data-s]')) {
    const params = el.dataset.version ? { version: el.dataset.version } : {};
    el.textContent = t(el.dataset.s, params);
  }
  for (const el of document.querySelectorAll('[data-s-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.sAria));
  }
}

function markCurrentTool() {
  for (const a of document.querySelectorAll('.tool-nav a')) {
    if (new URL(a.href).pathname === location.pathname) a.setAttribute('aria-current', 'page');
  }
}

function showEngineState(status, state) {
  const key = STATE_KEY[state];
  if (!key) return;
  root.dataset.engine = state;
  status.textContent = t(key);
}

function afterLoadAndIdle(fn) {
  const go = () => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: IDLE_FALLBACK_MS * 2 });
    else setTimeout(fn, IDLE_FALLBACK_MS);
  };
  if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
}

function boot() {
  fillStrings();
  markCurrentTool();
  const status = document.querySelector('[data-status]');
  const alertRegion = document.querySelector('[data-alert]');
  if (typeof Worker === 'undefined') {
    root.dataset.engine = 'unsupported';
    alertRegion.textContent = t('common.unsupportedBrowser');
    return;
  }
  showEngineState(status, 'preparing');
  engine.onState((state) => showEngineState(status, state));
  afterLoadAndIdle(() => { engine.ready().catch(() => {}); });
}

boot();
