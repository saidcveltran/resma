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

// After the engine has been ready once, a restart (a recycle) must not write over a message the tool put
// in the status region (a result, a count): the line is rewritten only while the region still holds the
// engine's own last line or nothing. The failed line always shows, because the visitor must see it.
let wasReady = false;
let lastLine = '';

function showEngineState(status, retry, state) {
  const key = STATE_KEY[state];
  if (!key) return;
  root.dataset.engine = state;
  const own = status.textContent === '' || status.textContent === lastLine;
  if (state === 'failed' || !wasReady || own) {
    lastLine = t(key);
    status.textContent = lastLine;
  }
  if (state === 'ready') wasReady = true;
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
  if (!status) return; // pages without a tool (home, not found, text pages) start no engine
  const alertRegion = document.querySelector('[data-alert]');
  const retry = document.querySelector('[data-engine-retry]');
  if (typeof Worker === 'undefined' || typeof DecompressionStream !== 'function') { // the PNG path needs it in the worker
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
