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
