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
export const MAX_ZOOM = 3;

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
