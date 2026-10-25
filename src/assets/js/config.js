// Constants shared by the page modules. Nothing here is read from the page or the URL.

// The engine worker lives next to the hashed app modules, so its URL follows the build id with no
// placeholder: it is resolved against this module's own (hashed) URL once, at load.
export const WORKER_URL = new URL('./worker/engine-worker.js', import.meta.url).href;

// Name of the single Trusted Types policy (the CSP allows exactly this name).
export const POLICY_NAME = 'resma-worker';

// No progress message for this long means the device cannot cope (DESIGN 6.7, TOO_LARGE).
export const WATCHDOG_MS = 60000;

// Engine prefetch: after load, in idle time; without requestIdleCallback after this delay.
export const IDLE_FALLBACK_MS = 1000;
