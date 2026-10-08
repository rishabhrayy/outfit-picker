import { describe, expect, it } from 'vitest';

import { controlsFromCrop, coverLayout, cropFromBox, cropFromControls, spotlightStyle } from '../src/lib/crop.js';

describe('cropFromBox', () => {
  it('turns a 0-1000 [yMin, xMin, yMax, xMax] box into a padded percentage crop', () => {
    // Shoes at the bottom of a full-length photo: wide and short.
    const crop = cropFromBox([850, 300, 950, 700], 0.1);
    expect(crop.unit).toBe('percent');
    expect(crop.x).toBeCloseTo(26);
    expect(crop.y).toBeCloseTo(84);
    expect(crop.width).toBeCloseTo(48);
    expect(crop.height).toBeCloseTo(12);
  });

  it('keeps the padded crop inside the photo', () => {
    const crop = cropFromBox([0, 0, 500, 1000]);
    expect(crop.x).toBe(0);
    expect(crop.y).toBe(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(100);
    expect(crop.y + crop.height).toBeLessThanOrEqual(100);
  });

  it.each([
    ['missing', undefined],
    ['the wrong length', [1, 2, 3]],
    ['not numbers', ['a', 0, 500, 500]],
    ['inverted', [600, 100, 400, 900]],
    ['a speck', [500, 500, 510, 700]],
    ['the whole photo', [0, 0, 1000, 1000]],
  ])('returns null for a box that is %s, leaving the full photo', (_label, box) => {
    expect(cropFromBox(box)).toBeNull();
  });

  it('is what the highlight box draws', () => {
    expect(spotlightStyle(cropFromBox([100, 200, 600, 800], 0))).toEqual({ top: '10%', left: '20%', width: '60%', height: '50%' });
  });
});

describe('coverLayout', () => {
  const photo = { naturalWidth: 1000, naturalHeight: 2000 };

  it('with no crop, covers the frame and centres the photo', () => {
    const layout = coverLayout({ ...photo, frameWidth: 200, frameHeight: 200, crop: null });
    expect(layout.width).toBe(200);
    expect(layout.height).toBe(400);
    expect(layout.top).toBe(-100);
    expect(layout.left).toBe(0);
  });

  it('keeps all of a tall crop in a square frame, instead of cutting it off', () => {
    // Trousers: the middle 40% of the width, rows 45%-95% of the height.
    const crop = { x: 30, y: 45, width: 40, height: 50, unit: 'percent' };
    const layout = coverLayout({ ...photo, frameWidth: 200, frameHeight: 200, crop });
    const boxHeightOnScreen = (crop.height / 100) * layout.height;
    expect(boxHeightOnScreen).toBeLessThanOrEqual(200.001);
    // ...and still fills the frame with no empty edges.
    expect(layout.left).toBeLessThanOrEqual(0);
    expect(layout.left + layout.width).toBeGreaterThanOrEqual(200);
  });

  it('zooms right in on small shoes at the bottom of a full-length photo', () => {
    const crop = cropFromBox([880, 350, 980, 650], 0);
    const layout = coverLayout({ ...photo, frameWidth: 300, frameHeight: 150, crop });
    // The shoes (300 x 200 px in the photo) fit the 300 x 150 frame whole,
    // filling it top to bottom: the zoom is set by whichever side is tighter.
    const shoesWidth = (crop.width / 100) * layout.width;
    const shoesHeight = (crop.height / 100) * layout.height;
    expect(shoesHeight).toBeCloseTo(150);
    expect(shoesWidth).toBeLessThanOrEqual(300.001);
    // And sit in view: their top edge is within the frame.
    const shoesTop = layout.top + (crop.y / 100) * layout.height;
    expect(shoesTop).toBeGreaterThanOrEqual(-0.001);
    expect(shoesTop).toBeLessThan(150);
  });

  it('never slides the photo past its own edges', () => {
    const crop = { x: 0, y: 0, width: 20, height: 10, unit: 'percent' };
    const layout = coverLayout({ ...photo, frameWidth: 200, frameHeight: 200, crop });
    expect(layout.left).toBe(0);
    expect(layout.top).toBe(0);
  });

  it('returns null until the photo and frame sizes are known', () => {
    expect(coverLayout({ naturalWidth: 0, naturalHeight: 100, frameWidth: 10, frameHeight: 10 })).toBeNull();
    expect(coverLayout({ ...photo, frameWidth: 0, frameHeight: 10 })).toBeNull();
  });

  it('agrees with the sliders, so a hand-made crop still round-trips', () => {
    const crop = cropFromControls({ zoom: 5, x: 50, y: 90 });
    expect(controlsFromCrop(crop).zoom).toBeCloseTo(5);
  });
});
