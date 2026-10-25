// C6 engine client: owns the single warm worker, created through the Trusted Types policy (CS-1).
import { WORKER_URL, POLICY_NAME, WATCHDOG_MS, START_TIMEOUT_MS } from './config.js';

// SEC-2: module scope; exact compare against the constant; returns the constant, never the input.
// No createHTML and no createScript. Without Trusted Types, spawn() uses the plain constant.
const policy = globalThis.trustedTypes
  ? globalThis.trustedTypes.createPolicy(POLICY_NAME, {
    createScriptURL(input) {
      if (input === WORKER_URL) return WORKER_URL;
      throw new TypeError('resma-worker: URL not allowed');
    },
  })
  : null;

export class EngineError extends Error {
  constructor(code, index) {
    super(code);
    this.name = 'EngineError';
    this.code = code;
    if (index !== undefined) this.index = index;
  }
}

function createEngine() {
  let worker = null;
  let state = 'idle'; // idle | preparing | ready | failed
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();

  function setState(next) {
    state = next;
    for (const fn of listeners) fn(next);
  }

  function dropWorker() {
    const w = worker;
    worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      w.terminate();
    }
  }

  function settle(id, fn) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  }

  function rejectAll(code) {
    for (const id of [...pending.keys()]) settle(id, (p) => p.reject(new EngineError(code)));
  }

  function arm(id) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      settle(id, (q) => q.reject(new EngineError('TOO_LARGE')));
      recycle();
    }, WATCHDOG_MS);
  }

  // The worker crashed or is stuck: fail the open calls, drop it and bring up a fresh one.
  function recycle() {
    rejectAll('INTERNAL');
    dropWorker();
    spawn();
  }

  function fail() {
    rejectAll('INTERNAL');
    rejectReady(new EngineError('INTERNAL'));
    setState('failed');
  }

  function spawn() {
    readyPromise = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    readyPromise.catch(() => {}); // a failed start is reported through the state and call()
    setState('preparing');
    let w;
    try {
      w = new Worker(policy ? policy.createScriptURL(WORKER_URL) : WORKER_URL, { type: 'module' });
    } catch {
      fail();
      return;
    }
    worker = w;
    let started = false;
    // A worker that never says ready (or says nothing at all) must not leave ready() waiting.
    const startTimer = setTimeout(() => {
      if (w !== worker || started) return;
      dropWorker();
      fail();
    }, START_TIMEOUT_MS);
    w.onmessage = (ev) => {
      if (w !== worker) return;
      const m = ev.data || {};
      if (m.type === 'ready') {
        started = true;
        clearTimeout(startTimer);
        resolveReady();
        setState('ready');
      } else if (m.type === 'error' && !started) {
        // The worker reports that it could not start.
        clearTimeout(startTimer);
        dropWorker();
        fail();
      } else if (m.type === 'progress') {
        const p = pending.get(m.id);
        if (p) { arm(m.id); if (p.onProgress) p.onProgress(m.done, m.total); }
      } else if (m.type === 'result') {
        settle(m.id, (p) => p.resolve(m));
      } else if (m.type === 'error') {
        settle(m.id, (p) => p.reject(new EngineError(m.code, m.index)));
      }
    };
    const broken = () => {
      if (w !== worker) return;
      clearTimeout(startTimer);
      if (started) { recycle(); } else { dropWorker(); fail(); }
    };
    w.onerror = broken;
    w.onmessageerror = broken;
  }

  return {
    get state() { return state; },
    onState(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // Starts the worker when there is none; resolves once it has posted ready.
    ready() {
      if (!worker && state !== 'preparing') spawn();
      return readyPromise;
    },
    async call(op, payload = {}, onProgress = null, transfer = []) {
      try { await this.ready(); } catch { throw new EngineError('INTERNAL'); }
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject, onProgress, timer: 0 });
        arm(id);
        try {
          worker.postMessage({ ...payload, id, op }, transfer);
        } catch {
          settle(id, (p) => p.reject(new EngineError('INTERNAL')));
        }
      });
    },
  };
}

export const engine = createEngine();
