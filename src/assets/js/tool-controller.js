// C2 tool controller: drives one tool page: choose files -> list -> action -> result.
// It reads the page markup by data attributes and renders only text (text nodes, setAttribute).
// The drop zone has a visual state (empty, compact once there are files, disabled while a job runs).
// When the controller is wired, <html data-tool="ready"> says so.
import { t } from './strings.es.js';
import { engine, EngineError } from './engine-client.js';
import { sniff } from './sniff.js';
import { LARGE_INPUT_BYTES } from './config.js';
import { createFileList } from './file-list.js';
import { createStatus, isolate } from './status.js';
import { createDownload, formatSize } from './download.js';

// Error codes that have a text in strings.es.js. Any other code is shown as INTERNAL, so t() is
// never asked for a missing key.
const KNOWN_ERRORS = new Set(['WRONG_TYPE_PDF', 'WRONG_TYPE_IMAGE', 'HEIC', 'PROTECTED', 'DAMAGED',
  'TOO_LARGE', 'IMAGE_UNSUPPORTED', 'INTERNAL']);
// Worker codes that make one input unusable (the user must remove that row).
const FILE_ERRORS = new Set(['WRONG_TYPE', 'PROTECTED', 'DAMAGED']);

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
  const status = createStatus(q('status'), q('alert'), q('progress'));
  const download = createDownload(slot, `${def.strings}.downloadSize`);

  let busy = false;
  let jobSeq = 0; // a job result counts only while its number is still the current one
  let inspecting = Promise.resolve();

  input.setAttribute('accept', def.acceptAttr);
  input.multiple = true;

  const list = createFileList(listEl, (action, id) => {
    if (busy) return;
    if (action === 'remove') removeRow(id);
    else moveRow(id, action === 'up' ? -1 : 1);
  });

  // With a result on screen the drop zone and the action button are hidden, so the download is the one
  // primary button. The list stays; changing it ends the result and brings them back.
  function showResult(on) {
    dropzone.hidden = on;
    actionBtn.hidden = on;
    resultEl.hidden = !on;
  }

  function dropzoneState() {
    dropzone.dataset.state = busy ? 'disabled' : list.entries().length > 0 ? 'compact' : 'empty';
  }

  // Any change of the list ends the current result and clears a stale error.
  function listChanged() {
    jobSeq += 1;
    download.revoke();
    showResult(false);
    status.clearError();
    chooseLabel.textContent = t(list.entries().length > 0 ? 'common.chooseMoreFiles' : 'common.chooseFiles');
    dropzoneState();
  }

  function setBusy(on) {
    busy = on;
    listEl.inert = on;
    actionBtn.setAttribute('aria-disabled', String(on));
    actionBtn.setAttribute('aria-busy', String(on));
    chooseBtn.setAttribute('aria-disabled', String(on));
    actionBtn.textContent = t(`${def.strings}.${on ? 'actionBusy' : 'action'}`);
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
      const bytes = await entry.file.arrayBuffer();
      const res = await engine.call('inspect', { files: [{ index: 0, kind, bytes }] }, null, [bytes]);
      list.update(entry.id, { status: 'ready', pages: res.pages });
    } catch (err) {
      const code = err instanceof EngineError ? err.code : 'INTERNAL';
      list.update(entry.id, { status: 'error', errorCode: errorKey(def, code) });
    }
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
      if (added.some((e) => list.get(e.id))) status.info(t('status.added', { count: added.length }));
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
      const res = await engine.call(def.op, { files, options: {} }, (done, of) => { if (!stale()) status.progress(done, of); }, buffers);
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
      const code = err instanceof EngineError ? err.code : 'INTERNAL';
      const entry = err instanceof EngineError && Number.isInteger(err.index) ? entries[err.index] : undefined;
      if (entry && FILE_ERRORS.has(code)) {
        list.update(entry.id, { status: 'error', errorCode: errorKey(def, code) });
      }
      failWith(code, entry ? entry.name : '');
    }
  }

  actionBtn.addEventListener('click', run);

  restartBtn.addEventListener('click', () => {
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
