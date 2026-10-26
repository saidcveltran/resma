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

// The worker must post ready within this time of being created, or the start counts as failed
// (so ready() never waits for ever on a worker that stays silent).
export const START_TIMEOUT_MS = 15000;

// Sniffer (DESIGN 6.7, C5): only the first bytes of a file are ever read to classify it.
export const SNIFF_BYTES = 1024;

// Output file name (DESIGN 6.5, SA-6): the whole name, suffix and ".pdf" included, stays within this.
export const OUTPUT_NAME_MAX = 80;
export const OUTPUT_EXTENSION = '.pdf';
export const OUTPUT_SUFFIX_MERGE = '-unido';
export const OUTPUT_SUFFIX_IMAGES = '-fotos';
export const OUTPUT_FALLBACK_MERGE = 'documento-unido.pdf';
export const OUTPUT_FALLBACK_IMAGES = 'fotos.pdf';
// Extensions removed from the first file's name before it becomes the base of the output name.
export const KNOWN_INPUT_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif'];

// Status region (DESIGN 6.3, C4): progress text changes at most once per this interval.
export const STATUS_THROTTLE_MS = 1000;

// Total input above this many bytes shows a non-blocking warning before the job (DESIGN 6.7).
export const LARGE_INPUT_BYTES = 100 * 1024 * 1024;

// Thumbnails (DESIGN 6.5, 6.7, CS-4): above this many images, or above LARGE_INPUT_BYTES in total, the rows show
// numbered tiles instead of thumbnails, to spare decoded-bitmap memory on phones.
export const THUMBNAIL_MAX_IMAGES = 30;
