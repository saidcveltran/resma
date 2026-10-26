// Op `merge`: join the pages of several PDFs, in order, into one new document.
// Page scripts and other active content are removed before the pages are copied (T12): the
// output keeps the page content, ordinary links and in-document links, and nothing else that runs.
import { EngineError, isResourceError } from '../errors.js';
import { readFiles, loadPdf } from './inspect.js';

// Pages and annotations are rebuilt from allowlists: only the keys named here are copied, so a
// key this code has never heard of (including one that points at the source catalog) goes nowhere.
//
// Annotation subtypes kept: Link, the text-markup and shape annotations that show an appearance, and
// Widget for its appearance only (no field keys, no field actions: the output is flat, not a form).
// Popup is dropped (its parent keeps the comment text), and so is every other subtype, which covers
// all media and attachment kinds (FileAttachment, Sound, Movie, Screen, RichMedia, 3D, Redact, ...).
const KEEP_SUBTYPES = new Set(['Link', 'Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine',
  'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Widget']);
// Display keys copied as plain values (numbers, strings, names, booleans and arrays or dictionaries of
// those). A value that holds a reference is dropped: nothing reachable from it is copied.
const ANNOT_PLAIN_KEYS = ['Contents', 'NM', 'M', 'F', 'AS', 'Border', 'BS', 'BE', 'C', 'IC', 'CA', 'QuadPoints',
  'InkList', 'Vertices', 'L', 'LE', 'Name', 'RD', 'CL', 'IT', 'DA', 'Q', 'DS', 'H'];
const WIDGET_PLAIN_KEYS = new Set(['F', 'AS', 'Border', 'BS', 'C']);
const PAGE_BOX_KEYS = ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox'];
const INHERITED_KEYS = new Set(['MediaBox', 'CropBox', 'Rotate', 'Resources']);
const RESOURCE_KEYS = ['ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'XObject', 'Font', 'ProcSet', 'Properties'];
const GROUP_KEYS = ['S', 'CS', 'I', 'K'];
// Keys that never belong to anything shown on a page, and actions that run or reach outside.
const ACTIVE_KEYS = ['AA', 'JS', 'JavaScript', 'OpenAction', 'XFA', 'EF', 'AF', 'PresSteps', 'EmbeddedFiles',
  'EmbeddedFile', 'Launch', 'SubmitForm', 'ImportData', 'GoToR'];
const ACTIVE_ACTIONS = new Set(['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'Named',
  'Hide', 'Rendition', 'SetOCGState', 'Thread', 'ResetForm', 'Movie', 'Sound', 'Trans', 'GoTo3DView',
  'RichMediaExecute']);
// Dictionaries whose keys are names the file chose (resource names, Type3 glyph names): a resource or a glyph called
// /JS or /AA is content, not an active key. Their own keys are left alone; what they point at is swept as usual.
const NAME_MAP_KEYS = new Set([...RESOURCE_KEYS.filter((k) => k !== 'ProcSet'), 'CharProcs']);
const PLAIN_DEPTH = 6;
// A link target must be an ordinary web, mail or phone address.
const SAFE_URI = /^(https?|mailto|tel):/i;

function key(lib, name) { return lib.PDFName.of(name); }

function typeName(lib, dict) {
  const t = dict instanceof lib.PDFDict ? dict.lookup(key(lib, 'Type')) : undefined;
  return t instanceof lib.PDFName ? t.decodeText() : '';
}

// A copy of a value made only of numbers, strings, names, booleans, null, arrays and dictionaries.
// The top level may be an indirect reference; a reference anywhere below, or a stream, gives undefined.
function plain(lib, ctx, raw, depth = 0) {
  const { PDFNumber, PDFString, PDFHexString, PDFName, PDFBool, PDFArray, PDFDict, PDFRef, PDFStream } = lib;
  const v = depth === 0 ? ctx.lookup(raw) : raw;
  if (v === undefined || v instanceof PDFRef || v instanceof PDFStream || depth > PLAIN_DEPTH) return undefined;
  if (v instanceof PDFNumber || v instanceof PDFString || v instanceof PDFHexString
    || v instanceof PDFName || v instanceof PDFBool || v === lib.PDFNull) return v;
  if (v instanceof PDFArray) {
    const items = [];
    for (let i = 0; i < v.size(); i++) {
      const item = plain(lib, ctx, v.get(i), depth + 1);
      if (item === undefined) return undefined;
      items.push(item);
    }
    return ctx.obj(items);
  }
  if (v instanceof PDFDict) {
    const out = ctx.obj({});
    for (const [k, val] of v.entries()) {
      const item = plain(lib, ctx, val, depth + 1);
      if (item === undefined) return undefined;
      out.set(k, item);
    }
    return out;
  }
  return undefined;
}

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

// A new annotation dictionary holding display keys only; the source annotation is left untouched
// (so an annotation listed on two pages is rebuilt, and re-pointed, once per page).
function rebuildAnnotation(lib, ctx, annot, pageIndexByTag) {
  const { PDFName, PDFDict, PDFArray, PDFStream } = lib;
  const subtype = annot.lookup(key(lib, 'Subtype'));
  if (!(subtype instanceof PDFName) || !KEEP_SUBTYPES.has(subtype.decodeText())) return null;
  const rect = plain(lib, ctx, annot.get(key(lib, 'Rect')));
  if (!(rect instanceof PDFArray)) return null;
  const isWidget = subtype.decodeText() === 'Widget';
  const out = ctx.obj({ Type: PDFName.of('Annot'), Subtype: subtype, Rect: rect });
  for (const name of ANNOT_PLAIN_KEYS) {
    if (isWidget && !WIDGET_PLAIN_KEYS.has(name)) continue;
    const v = plain(lib, ctx, annot.get(key(lib, name)));
    if (v !== undefined) out.set(key(lib, name), v);
  }
  // Appearance streams: only the N, R and D entries, each a stream or a dictionary of streams.
  const ap = ctx.lookup(annot.get(key(lib, 'AP')));
  if (ap instanceof PDFDict) {
    const outAp = ctx.obj({});
    for (const slot of ['N', 'R', 'D']) {
      const rawSlot = ap.get(key(lib, slot));
      const val = ctx.lookup(rawSlot);
      if (val instanceof PDFStream) {
        outAp.set(key(lib, slot), rawSlot);
      } else if (val instanceof PDFDict) {
        const states = ctx.obj({});
        for (const [k, item] of val.entries()) {
          if (ctx.lookup(item) instanceof PDFStream) states.set(k, item);
        }
        outAp.set(key(lib, slot), states);
      }
    }
    if (outAp.keys().length > 0) out.set(key(lib, 'AP'), outAp);
  }
  const aKey = key(lib, 'A');
  if (annot.has(aKey)) {
    const action = rebuildAction(lib, ctx, annot.get(aKey), pageIndexByTag);
    if (action) out.set(aKey, action);
  }
  if (!isWidget) {
    const dest = rebuildDest(lib, ctx, annot.get(key(lib, 'Dest')), pageIndexByTag);
    if (dest) out.set(key(lib, 'Dest'), dest);
  }
  return ctx.register(out);
}

// The page content: a stream, or an array of streams. Anything else is dropped.
function rebuildContents(lib, ctx, raw) {
  const { PDFStream, PDFArray, PDFRef } = lib;
  const v = ctx.lookup(raw);
  if (v instanceof PDFStream) return raw;
  if (!(v instanceof PDFArray)) return undefined;
  const items = [];
  for (let i = 0; i < v.size(); i++) {
    const item = v.get(i);
    if (item instanceof PDFRef && ctx.lookup(item) instanceof lib.PDFStream) items.push(item);
  }
  return ctx.obj(items);
}

function rebuildResources(lib, ctx, raw) {
  const res = ctx.lookup(raw);
  if (!(res instanceof lib.PDFDict)) return undefined;
  const out = ctx.obj({});
  for (const name of RESOURCE_KEYS) {
    const val = res.get(key(lib, name));
    const resolved = ctx.lookup(val);
    if (resolved instanceof lib.PDFDict || resolved instanceof lib.PDFArray) out.set(key(lib, name), val);
  }
  return out;
}

function rebuildGroup(lib, ctx, raw) {
  const group = ctx.lookup(raw);
  if (!(group instanceof lib.PDFDict)) return undefined;
  const out = ctx.obj({ Type: lib.PDFName.of('Group') });
  for (const name of GROUP_KEYS) {
    const val = group.get(key(lib, name));
    if (val !== undefined) out.set(key(lib, name), val);
  }
  return out;
}

// Rewrites the source page leaf in place so that it holds only the allowlisted keys. Inherited
// values (Resources, MediaBox, CropBox, Rotate) are resolved onto the page first, then the parent
// link is dropped, so the copy depends on nothing above the page.
function sanitizePage(lib, ctx, page, pageIndexByTag) {
  const { PDFName, PDFDict, PDFArray, PDFNumber, PDFPageLeaf } = lib;
  const node = page.node;
  const own = (name) => (INHERITED_KEYS.has(name) ? node.getInheritableAttribute(key(lib, name)) : node.get(key(lib, name)));
  const next = new Map();
  for (const name of PAGE_BOX_KEYS) {
    const v = plain(lib, ctx, own(name));
    if (v instanceof PDFArray) next.set(name, v);
  }
  for (const name of ['Rotate', 'UserUnit']) {
    const v = plain(lib, ctx, own(name));
    if (v instanceof PDFNumber) next.set(name, v);
  }
  const resources = rebuildResources(lib, ctx, own('Resources'));
  if (resources) next.set('Resources', resources);
  const contents = rebuildContents(lib, ctx, own('Contents'));
  if (contents) next.set('Contents', contents);
  const group = rebuildGroup(lib, ctx, own('Group'));
  if (group) next.set('Group', group);

  const kept = [];
  const list = ctx.lookup(own('Annots'));
  if (list instanceof PDFArray) {
    for (let i = 0; i < list.size(); i++) {
      const annot = ctx.lookup(list.get(i));
      if (!(annot instanceof PDFDict) || annot instanceof PDFPageLeaf) continue;
      if (['Page', 'Pages', 'Catalog'].includes(typeName(lib, annot))) continue; // a page listed as an annotation
      const rebuilt = rebuildAnnotation(lib, ctx, annot, pageIndexByTag);
      if (rebuilt) kept.push(rebuilt);
    }
  }
  next.set('Annots', ctx.obj(kept));

  for (const k of node.keys()) node.delete(k);
  node.set(PDFName.of('Type'), PDFName.of('Page'));
  for (const [name, v] of next) node.set(key(lib, name), v);
}

// Last line of defence over what the output pages can reach (form XObjects, fonts, appearance
// streams are copied whole): active keys are deleted, active actions are disarmed, and any
// catalog or page-tree object, or a page that is not one of ours, is cut out of its parent.
function sweep(lib, ctx, pages) {
  const { PDFDict, PDFArray, PDFRef, PDFStream } = lib;
  const ours = new Set(pages.map((p) => p.ref.tag));
  const seen = new Set();
  const stack = pages.map((p) => [p.ref, false]); // [reference, reached as the value of a name-map key]
  const foreign = (ref) => {
    const t = typeName(lib, ctx.lookup(ref) instanceof PDFStream ? ctx.lookup(ref).dict : ctx.lookup(ref));
    return t === 'Catalog' || t === 'Pages' || (t === 'Page' && !ours.has(ref.tag));
  };
  while (stack.length > 0) {
    const [ref, asMap] = stack.pop();
    const id = asMap ? `${ref.tag}m` : String(ref.tag); // reached both ways: swept as a plain dictionary too
    if (seen.has(id)) continue;
    seen.add(id);
    const top = ctx.lookup(ref);
    const visit = (o, isMap = false) => {
      const dict = o instanceof PDFStream ? o.dict : o;
      if (dict instanceof PDFDict) {
        const nameMap = isMap && !(o instanceof PDFStream);
        if (!nameMap) {
          for (const name of ACTIVE_KEYS) dict.delete(key(lib, name));
          const s = dict.lookup(key(lib, 'S'));
          if (s instanceof lib.PDFName && ACTIVE_ACTIONS.has(s.decodeText())) {
            for (const k of dict.keys()) dict.delete(k);
          }
        }
        for (const [k, v] of dict.entries()) {
          const childMap = !nameMap && NAME_MAP_KEYS.has(k.decodeText());
          if (v instanceof PDFRef) {
            if (foreign(v)) dict.delete(k); else stack.push([v, childMap]);
          } else if (v instanceof PDFDict || v instanceof PDFArray) visit(v, childMap);
        }
      } else if (o instanceof PDFArray) {
        for (let i = o.size() - 1; i >= 0; i--) {
          const v = o.get(i);
          if (v instanceof PDFRef) {
            if (foreign(v)) o.remove(i); else stack.push([v, false]);
          } else if (v instanceof PDFDict || v instanceof PDFArray) visit(v);
        }
      }
    };
    if (top !== undefined) visit(top, asMap);
  }
}

// The copier also copies what the cut keys pointed at before sweep() removed them. Delete every
// object that the output Root and Info do not reach, so none of it is written.
function dropUnreachable(lib, ctx) {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = lib;
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info];
  while (stack.length > 0) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      stack.push(ctx.lookup(o));
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFDict || o instanceof PDFStream) {
      for (const [, v] of (o instanceof PDFStream ? o.dict : o).entries()) stack.push(v);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) ctx.delete(ref);
  }
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
      sweep(lib, out.context, copied);
      for (const page of copied) out.addPage(page);
    } catch (err) {
      if (isResourceError(err)) throw new EngineError('TOO_LARGE', index);
      throw new EngineError('DAMAGED', index);
    }
    progress(i + 1, total);
  }
  // No title, author, subject, keywords or dates: only the tool name.
  out.setProducer('resma');
  out.setCreator('resma');
  dropUnreachable(lib, out.context);
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, pages: out.getPageCount() };
}
