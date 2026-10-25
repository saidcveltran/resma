// Op `merge`: join the pages of several PDFs, in order, into one new document.
// Page scripts and other active content are removed before the pages are copied (T12): the
// output keeps the page content, ordinary links and in-document links, and nothing else that runs.
import { EngineError } from '../errors.js';
import { readFiles, loadPdf } from './inspect.js';

// Annotation types that carry a file or play media; they are dropped.
const DROP_SUBTYPES = new Set(['FileAttachment', 'Sound', 'Movie', 'Screen', 'RichMedia', '3D']);
// A link target must be an ordinary web, mail or phone address.
const SAFE_URI = /^(https?|mailto|tel):/i;

function key(lib, name) { return lib.PDFName.of(name); }

function destTailOk(lib, v) {
  return v instanceof lib.PDFName || v instanceof lib.PDFNumber || v === lib.PDFNull;
}

// A destination [page /Fit ...] rebuilt as a new array whose first item is a placeholder page
// number; repointDestinations() puts the copied page's reference there after the copy. Referencing the
// source page directly would make the library copy that page a second time.
function rebuildDest(lib, ctx, raw, pageIndexByTag) {
  const { PDFArray, PDFRef } = lib;
  const arr = ctx.lookup(raw);
  if (!(arr instanceof PDFArray) || arr.size() < 1) return null;
  const first = arr.get(0);
  if (!(first instanceof PDFRef) || !pageIndexByTag.has(first.tag)) return null;
  const tail = [];
  for (let i = 1; i < arr.size(); i++) {
    const v = arr.get(i);
    if (!destTailOk(lib, v)) return null;
    tail.push(v);
  }
  return ctx.obj([lib.PDFNumber.of(pageIndexByTag.get(first.tag)), ...tail]);
}

// Only /URI and /GoTo survive, rebuilt from their own keys; /Next and everything else is gone.
function rebuildAction(lib, ctx, raw, pageIndexByTag) {
  const { PDFDict, PDFName, PDFString, PDFHexString, PDFBool } = lib;
  const act = ctx.lookup(raw);
  if (!(act instanceof PDFDict)) return null;
  const s = act.lookup(key(lib, 'S'));
  if (!(s instanceof PDFName)) return null;
  const kind = s.decodeText();
  if (kind === 'URI') {
    const uri = act.lookup(key(lib, 'URI'));
    if (!(uri instanceof PDFString || uri instanceof PDFHexString)) return null;
    let text = uri.decodeText();
    let start = 0;
    while (start < text.length && text.charCodeAt(start) <= 32) start++;
    text = text.slice(start);
    if (!SAFE_URI.test(text)) return null;
    const out = { S: PDFName.of('URI'), URI: uri };
    const isMap = act.lookup(key(lib, 'IsMap'));
    if (isMap instanceof PDFBool) out.IsMap = isMap;
    return ctx.obj(out);
  }
  if (kind === 'GoTo') {
    const dest = rebuildDest(lib, ctx, act.get(key(lib, 'D')), pageIndexByTag);
    return dest ? ctx.obj({ S: PDFName.of('GoTo'), D: dest }) : null;
  }
  return null;
}

function cleanAnnotation(lib, ctx, annot, pageIndexByTag, seen) {
  for (const k of ['AA', 'P', 'Parent', 'IRT']) annot.delete(key(lib, k));
  const aKey = key(lib, 'A');
  if (annot.has(aKey)) {
    const action = rebuildAction(lib, ctx, annot.get(aKey), pageIndexByTag);
    if (action) annot.set(aKey, action); else annot.delete(aKey);
  }
  const dKey = key(lib, 'Dest');
  if (annot.has(dKey)) {
    const dest = rebuildDest(lib, ctx, annot.get(dKey), pageIndexByTag);
    if (dest) annot.set(dKey, dest); else annot.delete(dKey);
  }
  // A popup is reached through /Popup even when the page does not list it; clean it as well.
  const popupKey = key(lib, 'Popup');
  if (annot.has(popupKey)) {
    const popup = ctx.lookup(annot.get(popupKey));
    if (popup instanceof lib.PDFDict && !seen.has(popup)) {
      seen.add(popup);
      cleanAnnotation(lib, ctx, popup, pageIndexByTag, seen);
    } else if (!(popup instanceof lib.PDFDict)) {
      annot.delete(popupKey);
    }
  }
}

function sanitizePage(lib, ctx, page, pageIndexByTag) {
  const { PDFArray, PDFDict, PDFName } = lib;
  page.node.delete(key(lib, 'AA'));
  const annotsKey = key(lib, 'Annots');
  if (!page.node.has(annotsKey)) return;
  const list = ctx.lookup(page.node.get(annotsKey));
  const kept = [];
  if (list instanceof PDFArray) {
    const seen = new Set();
    for (let i = 0; i < list.size(); i++) {
      const item = list.get(i);
      const annot = ctx.lookup(item);
      if (!(annot instanceof PDFDict)) continue;
      const subtype = annot.lookup(key(lib, 'Subtype'));
      if (subtype instanceof PDFName && DROP_SUBTYPES.has(subtype.decodeText())) continue;
      seen.add(annot);
      cleanAnnotation(lib, ctx, annot, pageIndexByTag, seen);
      kept.push(item);
    }
  }
  page.node.set(annotsKey, ctx.obj(kept));
}

// After the copy: every destination in the copied annotations still holds a placeholder page
// number (local destinations never legitimately start with a number); make it the new page.
function repointDestinations(lib, ctx, copiedPages) {
  const { PDFArray, PDFDict, PDFNumber } = lib;
  const fix = (arr) => {
    if (!(arr instanceof PDFArray) || !(arr.get(0) instanceof PDFNumber)) return true;
    const page = copiedPages[arr.get(0).asNumber()];
    if (!page) return false;
    arr.set(0, page.ref);
    return true;
  };
  for (const page of copiedPages) {
    const list = page.node.lookupMaybe(key(lib, 'Annots'), PDFArray);
    for (let i = 0; list && i < list.size(); i++) {
      const annot = ctx.lookup(list.get(i));
      if (!(annot instanceof PDFDict)) continue;
      const dest = ctx.lookup(annot.get(key(lib, 'Dest')));
      if (dest !== undefined && !fix(dest)) annot.delete(key(lib, 'Dest'));
      const action = ctx.lookup(annot.get(key(lib, 'A')));
      if (action instanceof PDFDict && !fix(ctx.lookup(action.get(key(lib, 'D'))))) annot.delete(key(lib, 'A'));
    }
  }
}

export async function run({ files }, lib, progress = () => {}) {
  const inputs = readFiles(files);
  const total = inputs.length;
  const out = await lib.PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < total; i++) {
    const { index, bytes } = inputs[i];
    const src = await loadPdf(lib, bytes, index);
    inputs[i].bytes = null; // the parsed copy is enough from here on
    const pages = src.getPages();
    const pageIndexByTag = new Map(pages.map((p, n) => [p.ref.tag, n]));
    try {
      for (const page of pages) sanitizePage(lib, src.context, page, pageIndexByTag);
      const copied = await out.copyPages(src, src.getPageIndices());
      repointDestinations(lib, out.context, copied);
      for (const page of copied) out.addPage(page);
    } catch (err) {
      if (err instanceof RangeError) throw new EngineError('TOO_LARGE', index);
      throw new EngineError('DAMAGED', index);
    }
    progress(i + 1, total);
  }
  // No title, author, subject, keywords or dates: only the tool name.
  out.setProducer('resma');
  out.setCreator('resma');
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, pages: out.getPageCount() };
}
