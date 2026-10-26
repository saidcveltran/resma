// C13 tool definition for "JPG a PDF". This module is the page's entry for the tool: it starts it.
//
// Photos are checked on add from the head only (the first 1 MiB), with the bounded parsers (CS-5); nothing is decoded. A PNG over
// the pixel cap is a row error; a JPEG over it is converted without a decode and gets a tile, not a thumbnail.
import { outputName } from '../filename.js';
import { bootTool } from '../tool-controller.js';
import { EngineError } from '../engine-client.js';
import { readJpegInfo, readPngInfo, SCAN_CAP_BYTES, PIXEL_CAP } from '../worker/exif.js';

async function inspectImage(file, kind) {
  if (kind === 'jpeg') {
    const info = readJpegInfo(new Uint8Array(await file.slice(0, SCAN_CAP_BYTES).arrayBuffer()));
    if (!info.ok) throw new EngineError(info.code);
    return { decodable: !info.tooBigToDecode && info.pixels <= PIXEL_CAP, pixels: info.pixels };
  }
  // The real size goes along, so a chunk past the end of the file is damaged; the whole file is read when the job runs.
  const info = readPngInfo(new Uint8Array(await file.slice(0, SCAN_CAP_BYTES).arrayBuffer()), file.size);
  if (!info.ok) throw new EngineError(info.code);
  return { decodable: info.pixels <= PIXEL_CAP, pixels: info.pixels };
}

const options = (panel) => {
  const value = (name) => panel.querySelector(`[data-option="${name}"]`).value;
  return { size: value('size'), orientation: value('orientation'), margin: value('margin') };
};

const definition = {
  accepts: ['jpeg', 'png'],
  acceptAttr: 'image/jpeg,image/png,.jpg,.jpeg,.png',
  wrongType: 'WRONG_TYPE_IMAGE',
  minFiles: 1,
  op: 'images',
  outputName: (entries) => outputName('images', entries[0].name, entries.length),
  strings: 'images',
  inspect: inspectImage,
  options,
  thumbnails: { placeholderKey: 'images.thumbPlaceholder', types: { jpeg: 'image/jpeg', png: 'image/png' } },
};

bootTool(definition);
