// C1 page shell: static text is rendered at build time ({{s:key}}); this module writes only the dynamic
// status text, checks the browser and prefetches the engine. The engine line (preparing, ready or
// failed) is the one status the visitor can rely on before going offline; when it fails, a retry
// button starts the engine again.
import { t } from './strings.es.js';
import { engine } from './engine-client.js';
import { IDLE_FALLBACK_MS } from './config.js';
import { showAlert } from './status.js';

const root = document.documentElement;
const STATE_KEY = { preparing: 'engine.preparing', ready: 'engine.ready', failed: 'engine.failed' };

function markCurrentTool() {
  for (const a of document.querySelector('.tool-nav')?.querySelectorAll('a') ?? []) {
    if (new URL(a.href).pathname === location.pathname) a.setAttribute('aria-current', 'page');
  }
}

function showEngineState(status, retry, state) {
  const key = STATE_KEY[state];
  if (!key) return;
  root.dataset.engine = state;
  status.textContent = t(key);
  if (retry) retry.hidden = state !== 'failed';
}

function afterLoadAndIdle(fn) {
  const go = () => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: IDLE_FALLBACK_MS * 2 });
    else setTimeout(fn, IDLE_FALLBACK_MS);
  };
  if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
}

function boot() {
  markCurrentTool();
  const status = document.querySelector('[data-status]');
  const alertRegion = document.querySelector('[data-alert]');
  const retry = document.querySelector('[data-engine-retry]');
  if (typeof Worker === 'undefined') {
    root.dataset.engine = 'unsupported';
    showAlert(alertRegion, t('common.unsupportedBrowser'));
    return;
  }
  showEngineState(status, retry, 'preparing');
  engine.onState((state) => showEngineState(status, retry, state));
  if (retry) retry.addEventListener('click', () => { engine.ready().catch(() => {}); });
  afterLoadAndIdle(() => { engine.ready().catch(() => {}); });
}

boot();
