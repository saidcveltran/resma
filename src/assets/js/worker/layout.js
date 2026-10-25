// Page size and image placement (DESIGN 6.5, C8). Pure math in PDF points; nothing is drawn here.
// place(img, options) -> { page: { width, height, margin }, ctm: [a, b, c, d, e, f] }
// The matrix maps the unit square the PDF draws an image in to the page (origin at the bottom left,
// y up) and applies the EXIF orientation, mirrored cases included.

export const A4_PT = Object.freeze({ width: 595.28, height: 841.89 });
export const LETTER_PT = Object.freeze({ width: 612, height: 792 });
export const SMALL_MARGIN_PT = 28.35; // 10 mm
export const MAX_PAGE_PT = 14400; // the PDF limit per side
export const MIN_PAGE_PT = 3; // ISO 32000 Annex C: the smallest page size viewers are required to accept
export const PIXEL_TO_PT = 0.75; // 96 dpi pixels to points

// Stored pixel (sx, sy), origin top left, to displayed (dx, dy), by orientation:
//   dx = ax*sx + bx*sy + cx, dy = ay*sx + by*sy + cy   (cx, cy are 0, W or H)
// Each row: [ax, bx, cx (0 | 'W' | 'H'), ay, by, cy].
const ORIENTATION = {
  1: [1, 0, 0, 0, 1, 0],
  2: [-1, 0, 'W', 0, 1, 0],
  3: [-1, 0, 'W', 0, -1, 'H'],
  4: [1, 0, 0, 0, -1, 'H'],
  5: [0, 1, 0, 1, 0, 0],
  6: [0, -1, 'H', 1, 0, 0],
  7: [0, -1, 'H', -1, 0, 'W'],
  8: [0, 1, 0, -1, 0, 'W'],
};

const norm = (n) => n + 0; // turns -0 into 0
const isSide = (n) => Number.isInteger(n) && n > 0;

export function place(img, options) {
  if (!img || typeof img !== 'object' || !isSide(img.width) || !isSide(img.height)) {
    throw new TypeError('bad-image-size'); // whole, positive width and height are required
  }
  const opts = options && typeof options === 'object' ? options : {};
  const W = img.width;
  const H = img.height;
  const orientation = Number.isInteger(img.orientation) && img.orientation >= 1 && img.orientation <= 8 ? img.orientation : 1;
  const swap = orientation >= 5;
  const dw = swap ? H : W; // displayed size in pixels
  const dh = swap ? W : H;

  let pageW;
  let pageH;
  let margin;
  let scale;
  if (opts.size === 'image') {
    // Page = displayed pixels x 0.75, no margin; scaled down when a side would pass the PDF limit.
    const shrink = Math.min(1, MAX_PAGE_PT / (Math.max(dw, dh) * PIXEL_TO_PT));
    scale = PIXEL_TO_PT * shrink;
    // A side below MIN_PAGE_PT (a long thin strip) is raised to it. The image keeps its scale and is
    // centred on that side, so it is not stretched; the page then has a blank border along that side.
    pageW = Math.max(MIN_PAGE_PT, Math.min(MAX_PAGE_PT, dw * scale));
    pageH = Math.max(MIN_PAGE_PT, Math.min(MAX_PAGE_PT, dh * scale));
    margin = 0;
  } else {
    const base = opts.size === 'letter' ? LETTER_PT : A4_PT;
    const landscape = opts.orientation === 'landscape' || (opts.orientation !== 'portrait' && dw > dh);
    pageW = landscape ? base.height : base.width;
    pageH = landscape ? base.width : base.height;
    margin = opts.margin === 'none' ? 0 : SMALL_MARGIN_PT;
    scale = Math.min((pageW - 2 * margin) / dw, (pageH - 2 * margin) / dh); // minimum fit, up or down
  }
  const x0 = (pageW - dw * scale) / 2;
  const y0 = (pageH - dh * scale) / 2;

  const [ax, bx, cxk, ay, by, cyk] = ORIENTATION[orientation];
  const at = (k) => (k === 'W' ? W : k === 'H' ? H : 0);
  const cx = at(cxk);
  const cy = at(cyk);
  // X = x0 + s*dx and Y = y0 + s*(dh - dy), with sx = u*W and sy = (1 - v)*H for the unit square (u, v).
  const ctm = [
    scale * ax * W, // a
    -scale * ay * W, // b
    -scale * bx * H, // c
    scale * by * H, // d
    x0 + scale * (bx * H + cx), // e
    y0 + scale * dh - scale * (by * H + cy), // f
  ].map(norm);
  return { page: { width: pageW, height: pageH, margin }, ctm };
}
