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
// Also above this many pixels in total (width x height of the listed images; 4 images of 4000 x 4000 sit exactly on it):
// a thumbnail is a decoded bitmap of the whole picture, so the sum is what a phone has to hold.
export const THUMBNAIL_MAX_PIXELS = 64000000;

// A kept ICC colour profile (DESIGN 6.5, SA-10) is at most this many bytes; a bigger one is dropped and the image still
// converts. Display profiles are a few KB; the cap keeps a profile from carrying a payload.
export const ICC_MAX_BYTES = 1048576;

// Parse-time budget (DESIGN 21, T8/T11): bytes inflated from the streams the parser must decode (object and cross-reference
// streams), per stream and per file, and the longest string or name token inside them. A cap passed is TOO_LARGE.
export const PARSE_STREAM_MAX_BYTES = 32 * 1024 * 1024;
export const PARSE_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const PARSE_TOKEN_MAX_BYTES = 8 * 1024 * 1024;
