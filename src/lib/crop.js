/**
 * Crop geometry for wardrobe items.
 *
 * One photo can hold several items, so each item keeps its own crop rather than
 * getting its own copy of the pixels. The crop is stored as a percentage rect of
 * the source photo and rendered with a CSS transform, which means a re-crop is
 * instant and never degrades the original image.
 *
 * The UI exposes the crop as three sliders (zoom, horizontal, vertical); these
 * helpers convert between that control shape and the stored rect.
 */

export const DEFAULT_CONTROLS = Object.freeze({ zoom: 1, x: 50, y: 50 });
export const MIN_ZOOM = 1;
// Shoes in a full-length mirror photo take up about a sixth of its height.
export const MAX_ZOOM = 6;

/**
 * Turns a detected garment's box into a stored crop. The box is the format
 * Gemini is trained to give, [yMin, xMin, yMax, xMax] scaled to 0-1000, and
 * is padded a little so the garment isn't cut off at its edges. Returns null
 * for anything unusable (missing, inverted, tiny, or the whole photo), which
 * leaves the item showing the full photo as before.
 */
export function cropFromBox(box, padding = 0.08) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [yMin, xMin, yMax, xMax] = box.map(Number);
  if (![yMin, xMin, yMax, xMax].every(Number.isFinite)) return null;
  if (yMin >= yMax || xMin >= xMax) return null;

  const scale = (value) => clamp(value / 10, 0, 100);
  const top = scale(yMin);
  const left = scale(xMin);
  const height = scale(yMax) - top;
  const width = scale(xMax) - left;
  // Smaller than 3% either way is a stray mark, not a garment.
  if (width < 3 || height < 3) return null;
  // Practically the whole photo: nothing to crop to.
  if (width > 92 && height > 92) return null;

  const padX = width * padding;
  const padY = height * padding;
  const x = clamp(left - padX, 0, 100);
  const y = clamp(top - padY, 0, 100);
  return {
    x,
    y,
    width: clamp(left + width + padX, 0, 100) - x,
    height: clamp(top + height + padY, 0, 100) - y,
    unit: 'percent',
  };
}

/**
 * Where to draw a photo so its crop fills a frame of any shape. The whole crop
 * is kept in view (so tall trousers aren't cut off in a square frame), the
 * frame is never left with empty space, and the crop is centred as far as the
 * photo's edges allow. Returns pixel sizes and offsets for the image.
 */
export function coverLayout({ naturalWidth, naturalHeight, frameWidth, frameHeight, crop }) {
  const nw = Number(naturalWidth);
  const nh = Number(naturalHeight);
  const fw = Number(frameWidth);
  const fh = Number(frameHeight);
  if (![nw, nh, fw, fh].every((value) => Number.isFinite(value) && value > 0)) return null;

  const rect = crop && Number(crop.width) > 0 && Number(crop.height) > 0
    ? crop
    : { x: 0, y: 0, width: 100, height: 100 };
  const boxWidth = (Number(rect.width) / 100) * nw;
  const boxHeight = (Number(rect.height) / 100) * nh;

  const fitBox = Math.min(fw / boxWidth, fh / boxHeight);
  const coverFrame = Math.max(fw / nw, fh / nh);
  const scale = Math.max(fitBox, coverFrame);

  const width = nw * scale;
  const height = nh * scale;
  const centreX = ((Number(rect.x) + Number(rect.width) / 2) / 100) * nw * scale;
  const centreY = ((Number(rect.y) + Number(rect.height) / 2) / 100) * nh * scale;

  return {
    width,
    height,
    left: clamp(fw / 2 - centreX, fw - width, 0),
    top: clamp(fh / 2 - centreY, fh - height, 0),
  };
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

/**
 * Converts zoom/position sliders into the stored percentage rect.
 *
 * A zoom of z shows 1/z of each dimension, anchored so the chosen point stays
 * put — the same behaviour as `transform: scale(z)` with a matching origin.
 */
export function cropFromControls(controls = DEFAULT_CONTROLS) {
  const zoom = clamp(controls?.zoom, MIN_ZOOM, MAX_ZOOM);
  const originX = clamp(controls?.x, 0, 100);
  const originY = clamp(controls?.y, 0, 100);
  const visible = 100 / zoom;
  const anchor = 1 - 1 / zoom;

  return {
    x: originX * anchor,
    y: originY * anchor,
    width: visible,
    height: visible,
    unit: 'percent',
  };
}

/**
 * Inverse of cropFromControls, so a saved item can be re-cropped later.
 */
export function controlsFromCrop(crop) {
  const width = Number(crop?.width);
  if (!crop || !Number.isFinite(width) || width <= 0 || width >= 100) {
    return { ...DEFAULT_CONTROLS };
  }

  const zoom = clamp(100 / width, MIN_ZOOM, MAX_ZOOM);
  const anchor = 1 - 1 / zoom;
  if (anchor <= 0) {
    return { ...DEFAULT_CONTROLS };
  }

  return {
    zoom,
    x: clamp(Number(crop.x) / anchor, 0, 100),
    y: clamp(Number(crop.y) / anchor, 0, 100),
  };
}

/**
 * Inline style that renders a crop inside an overflow-hidden frame.
 */
export function cropStyle(crop) {
  const { zoom, x, y } = controlsFromCrop(crop);
  if (zoom <= MIN_ZOOM + 0.001) {
    return undefined;
  }

  return { transform: `scale(${zoom})`, transformOrigin: `${x}% ${y}%` };
}

/**
 * Position for a highlight box drawn OVER the full, unzoomed source photo —
 * the opposite move from cropStyle, which zooms into just the item and hides
 * the rest of the photo. This is what shows an item in the context of the
 * whole outfit it was photographed in: the crop rect is already stored as a
 * percentage box, so this reads it directly instead of converting through
 * zoom/pan controls.
 *
 * Returns null when there is no meaningful crop (the item uses the whole
 * photo), in which case nothing needs highlighting.
 */
export function spotlightStyle(crop) {
  const width = Number(crop?.width);
  const height = Number(crop?.height);
  if (!crop || crop.unit !== 'percent' || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width >= 99.5 && height >= 99.5) {
    // Effectively the full photo — a highlight box here would just outline
    // the whole image, which tells the viewer nothing.
    return null;
  }

  const x = clamp(Number(crop.x) || 0, 0, 100);
  const y = clamp(Number(crop.y) || 0, 0, 100);
  const safeWidth = clamp(width, 1, 100 - x);
  const safeHeight = clamp(height, 1, 100 - y);

  return {
    top: `${y}%`,
    left: `${x}%`,
    width: `${safeWidth}%`,
    height: `${safeHeight}%`,
  };
}
