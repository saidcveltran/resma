// C2 tool controller: drives one tool page: choose files -> list -> action -> result.
// It reads the page markup by data attributes and renders only text (text nodes, setAttribute).
// The drop zone has a visual state (empty, compact once there are files, active while files are dragged
// over it, disabled while a job runs). Dropping files on it is a desktop extra: it feeds the same
// addFiles() path as the picker.
// A definition may add `inspect(file, kind)` (a head check on add instead of the worker's PDF inspect),
// `options(panel)` (job options read from [data-options]) and `thumbnails` (rows show pictures).
// When the controller is wired, <html data-tool="ready"> says so.
import { t } from './strings.es.js';
import { engine, EngineError } from './engine-client.js';
import { sniff } from './sniff.js';
import { LARGE_INPUT_BYTES, THUMBNAIL_MAX_IMAGES } from './config.js';
import { createFileList } from './file-list.js';
import { createStatus, isolate } from './status.js';
import { createDownload, formatSize } from './download.js';

// Error codes that have a text in strings.es.js. Any other code is shown as INTERNAL, so t() is
// never asked for a missing key.
const KNOWN_ERRORS = new Set(['WRONG_TYPE_PDF', 'WRONG_TYPE_IMAGE', 'HEIC', 'PROTECTED', 'DAMAGED',
  'TOO_LARGE', 'IMAGE_TOO_BIG', 'IMAGE_UNSUPPORTED', 'INTERNAL']);
// Worker codes that make one input unusable (the user must remove that row).
const FILE_ERRORS = new Set(['WRONG_TYPE', 'PROTECTED', 'DAMAGED', 'IMAGE_TOO_BIG', 'IMAGE_UNSUPPORTED']);

function errorKey(def, code) {
  const mapped = code === 'WRONG_TYPE' ? def.wrongType : code;
  return KNOWN_ERRORS.has(mapped) ? mapped : 'INTERNAL';
}

// createTool(def, root): wires the page parts found under `root` to the tool definition `def`.
export function createTool(def, root = document) {
  const q = (name) => root.querySelector(`[data-${name}]`);
  const chooseBtn = q('choose');
  const chooseLabel = chooseBtn.querySelector('[data-choose-label]') || chooseBtn;
  const dropzone = q('dropzone');
  const input = q('input');
  const listEl = q('list');
  const actionBtn = q('action');
  const resultEl = q('result');
  const slot = q('result-slot');
  const restartBtn = q('restart');
  const optionsEl = q('options');
  const status = createStatus(q('status'), q('alert'), q('progress'));
  const download = createDownload(slot, `${def.strings}.downloadSize`);

  const hintEl = dropzone.querySelector('.hint');
  const idleHint = hintEl ? hintEl.textContent : '';
  let busy = false;
  let dragging = false; // files are being dragged over the zone
  let jobSeq = 0; // a job result counts only while its number is still the current one
  let inspecting = Promise.resolve();

  input.setAttribute('accept', def.acceptAttr);
  input.multiple = true;

  const list = createFileList(listEl, (action, id) => {
    if (busy) return;
    if (action === 'remove') removeRow(id);
    else moveRow(id, action === 'up' ? -1 : 1);
  }, { thumbnails: def.thumbnails || null });

  // Thumbnails (CS-4): an object URL of a NEW Blob typed from the sniffed kind, never the File or its reported
  // type. Only for a ready, `decodable` row while the list is small; else a numbered tile. Revoked on removal,
  // restart and when the list outgrows the limits.
  function releaseThumbnail(entry) {
    if (!entry.thumbUrl) return;
    URL.revokeObjectURL(entry.thumbUrl);
    list.update(entry.id, { thumbUrl: null }, false);
  }

  function refreshThumbnails() {
    if (!def.thumbnails) return;
    const entries = list.entries();
    const total = entries.reduce((n, e) => n + e.size, 0);
    const room = entries.length <= THUMBNAIL_MAX_IMAGES && total <= LARGE_INPUT_BYTES;
    for (const e of entries) {
      const type = def.thumbnails.types[e.kind];
      const wanted = room && e.status === 'ready' && e.decodable === true && typeof type === 'string';
      if (wanted && !e.thumbUrl) {
        list.update(e.id, { thumbUrl: URL.createObjectURL(new Blob([e.file], { type })) }, false);
      } else if (!wanted) {
        releaseThumbnail(e);
      }
    }
    list.redraw();
  }

  // With a result on screen the drop zone and the action button are hidden, so the download is the one
  // primary button. The list stays; changing it ends the result and brings them back.
  function showResult(on) {
    dropzone.hidden = on;
    actionBtn.hidden = on;
    resultEl.hidden = !on;
  }

  function dropzoneState() {
    const files = list.entries().length > 0;
    dropzone.dataset.state = busy ? 'disabled' : dragging ? 'active' : files ? 'compact' : 'empty';
    dropzone.toggleAttribute('data-compact', files); // lets the active state keep the layout it has
    if (hintEl) hintEl.textContent = dropzone.dataset.state === 'active' ? t('common.dropActive') : idleHint;
  }

  // Any change of the list ends the current result and clears a stale error.
  function listChanged() {
    jobSeq += 1;
    download.revoke();
    showResult(false);
    status.clearError();
    chooseLabel.textContent = t(list.entries().length > 0 ? 'common.chooseMoreFiles' : 'common.chooseFiles');
    dropzoneState();
    refreshThumbnails();
  }

  function setBusy(on) {
    busy = on;
    listEl.inert = on;
    actionBtn.setAttribute('aria-disabled', String(on));
    actionBtn.setAttribute('aria-busy', String(on));
    chooseBtn.setAttribute('aria-disabled', String(on));
    actionBtn.textContent = t(`${def.strings}.${on ? 'actionBusy' : 'action'}`);
    if (optionsEl) optionsEl.inert = on;
    dropzoneState();
  }

  function failWith(code, name) {
    status.error(t(`errors.${errorKey(def, code)}`, { name: isolate(name) }));
    status.focusAlert();
  }

  // ---- adding and checking files

  async function inspectEntry(entry) {
    const kind = await sniff(entry.file);
    if (!def.accepts.includes(kind)) {
      list.update(entry.id, { kind, status: 'error', errorCode: kind === 'heic' ? 'HEIC' : def.wrongType });
      return;
    }
    list.update(entry.id, { kind });
    try {
      if (def.inspect) {
            list.update(entry.id, { ...(await def.inspect(entry.file, kind)), status: 'ready' });
      } else {
        const bytes = await entry.file.arrayBuffer();
        const res = await engine.call('inspect', { files: [{ index: 0, kind, bytes }] }, null, [bytes]);
        list.update(entry.id, { status: 'ready', pages: res.pages });
      }
    } catch (err) {
      const code = err instanceof EngineError ? err.code : err instanceof RangeError ? 'TOO_LARGE' : 'INTERNAL';
      list.update(entry.id, { status: 'error', errorCode: errorKey(def, code) });
    }
    refreshThumbnails();
  }

  function addFiles(files) {
    if (busy || files.length === 0) return;
    const added = list.add(files);
    listChanged();
    status.info(t('status.checking', { count: added.length }));
    // One file at a time, so only one file's bytes are in the worker at once.
    inspecting = inspecting.then(async () => {
      for (const entry of added) {
        if (list.get(entry.id)) await inspectEntry(entry);
      }
      if (!added.some((e) => list.get(e.id))) return;
      // A large total gets its non-blocking warning as soon as the files are in, in the same message.
      const total = list.entries().reduce((n, e) => n + e.size, 0);
      const note = t('status.added', { count: added.length });
      status.info(total > LARGE_INPUT_BYTES ? `${note} ${t('status.largeWarning', { size: formatSize(total) })}` : note);
    });
  }

  chooseBtn.addEventListener('click', () => {
    if (!busy) input.click();
  });
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    addFiles(files);
  });

  // ---- dropping files on the zone (desktop extra; the button stays the way in)

  const carriesFiles = (ev) => Array.from((ev.dataTransfer && ev.dataTransfer.types) || []).includes('Files');
  let depth = 0; // dragenter minus dragleave over the zone and its children

  function endDrag() {
    depth = 0;
    if (!dragging) return;
    dragging = false;
    dropzoneState();
  }

  dropzone.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    if (!carriesFiles(ev)) return;
    depth += 1;
    if (!busy && !dragging) {
      dragging = true;
      dropzoneState();
    }
  });
  dropzone.addEventListener('dragover', (ev) => {
    ev.preventDefault(); // without this the browser does not deliver the drop
    ev.dataTransfer.dropEffect = !busy && carriesFiles(ev) ? 'copy' : 'none';
  });
  dropzone.addEventListener('dragleave', (ev) => {
    if (!carriesFiles(ev)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) endDrag();
  });
  dropzone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    endDrag();
    if (busy) return;
    const files = Array.from(ev.dataTransfer ? ev.dataTransfer.files : []);
    if (files.length > 0) {
      addFiles(files);
    } else {
      status.error(t('errors.dropNotFiles'));
      status.focusAlert();
    }
  });
  // A file dropped anywhere else must not make the browser open it and leave the page.
  const guardOutside = (ev) => {
    if (!carriesFiles(ev) || dropzone.contains(ev.target)) return;
    ev.preventDefault();
    if (ev.type === 'dragover') ev.dataTransfer.dropEffect = 'none';
  };
  const doc = root.ownerDocument || root;
  doc.addEventListener('dragover', guardOutside);
  doc.addEventListener('drop', guardOutside);

  // ---- order and removal

  function moveRow(id, delta) {
    const entry = list.get(id);
    const to = list.move(id, delta);
    if (!entry || to < 0) return;
    listChanged();
    list.focusButton(id, delta < 0 ? 'up' : 'down');
    status.info(t('status.moved', { name: isolate(entry.name), position: to + 1, total: list.entries().length }));
  }

  function removeRow(id) {
    const removed = list.remove(id);
    if (!removed) return;
    releaseThumbnail(removed.entry); // its row is gone: give its picture back
    listChanged();
    const rest = list.entries();
    const next = rest[removed.index] || rest[removed.index - 1];
    if (next) list.focusButton(next.id, 'remove');
    else chooseBtn.focus();
    status.info(t('status.removed', { name: isolate(removed.entry.name), count: rest.length }));
  }

  // ---- the action

  async function run() {
    if (busy) return;
    // The job slot is taken before any await, so a second press right away does nothing.
    const job = ++jobSeq;
    const stale = () => job !== jobSeq;
    setBusy(true);
    const refuse = (text) => {
      setBusy(false);
      status.error(text);
      status.focusAlert();
    };
    await inspecting;
    if (stale()) return;
    const entries = list.entries();
    const bad = entries.filter((e) => e.status !== 'ready');
    if (entries.length === 0) return refuse(t('errors.noFiles'));
    if (bad.length > 0) return refuse(t('errors.rowSummary', { count: bad.length }));
    if (entries.length < def.minFiles) return refuse(t('errors.tooFew', { min: def.minFiles }));

    status.clearError();
    download.revoke();
    showResult(false);
    const total = entries.reduce((n, e) => n + e.size, 0);
    if (total > LARGE_INPUT_BYTES) status.info(t('status.largeWarning', { size: formatSize(total) }));
    status.start(entries.length);
    try {
      const buffers = [];
      for (const e of entries) {
        buffers.push(await e.file.arrayBuffer());
        if (stale()) return;
      }
      const files = buffers.map((bytes, index) => ({ index, kind: entries[index].kind, bytes }));
      const options = def.options && optionsEl ? def.options(optionsEl) : {};
      const res = await engine.call(def.op, { files, options }, (done, of) => { if (!stale()) status.progress(done, of); }, buffers);
      if (stale()) return; // the list changed or was restarted meanwhile: this result is dropped
      const size = res.bytes.byteLength;
      const link = download.offer(res.bytes, def.outputName(entries));
      showResult(true);
      status.info(t('status.done', { pages: res.pages, size: formatSize(size) }));
      setBusy(false);
      link.focus();
    } catch (err) {
      if (stale()) return;
      setBusy(false);
      // A crash or restart during the job is the "too large" class (DESIGN 6.7); a worker answer keeps its code.
      const crashed = err instanceof EngineError && err.crash === true;
      const code = crashed ? 'TOO_LARGE' : err instanceof EngineError ? err.code : 'INTERNAL';
      status.info(''); // the "Procesando…" line of the lost job must not stay on screen
      const entry = err instanceof EngineError && Number.isInteger(err.index) ? entries[err.index] : undefined;
      if (entry && FILE_ERRORS.has(code)) {
        list.update(entry.id, { status: 'error', errorCode: errorKey(def, code) });
        refreshThumbnails();
      }
      failWith(code, entry ? entry.name : '');
    }
  }

  actionBtn.addEventListener('click', run);

  // A changed option makes a shown result stale: it ends like any other change of the inputs.
  if (optionsEl) optionsEl.addEventListener('change', () => { if (!busy) listChanged(); });

  restartBtn.addEventListener('click', () => {
    for (const e of list.entries()) releaseThumbnail(e);
    list.clear();
    listChanged(); // also ends a job that is still running: its result is dropped
    setBusy(false);
    status.clear();
    status.info(t('status.cleared'));
    chooseBtn.focus();
  });

  chooseLabel.textContent = t('common.chooseFiles');
  setBusy(false);
  (root.documentElement || root).dataset.tool = 'ready';
}

// Starts the tool on the current page, unless the browser cannot run the engine (app.js says so).
export function bootTool(def, root = document) {
  if (typeof Worker === 'undefined') {
    const choose = root.querySelector('[data-choose]');
    if (choose) choose.setAttribute('aria-disabled', 'true');
    return null;
  }
  return createTool(def, root);
}
