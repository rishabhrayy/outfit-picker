/**
 * Turns a picked file into something both IndexedDB and the vision API are
 * happy with: a reasonably sized JPEG plus its base64 data URL.
 *
 * Phone photos are routinely 3-12 MB, which is slow to upload and wasteful to
 * keep forever in browser storage. Re-encoding also converts iPhone HEIC files
 * into a format every browser and the API can read.
 */

const MAX_EDGE = 1400;
const JPEG_QUALITY = 0.86;
const API_SAFE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const prepared = new WeakMap();

function isBlobLike(value) {
  return Boolean(value && typeof value === 'object' && typeof value.arrayBuffer === 'function');
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('This image could not be read from your device.'));
    reader.readAsDataURL(blob);
  });
}

async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to the <img> path, which some browsers handle instead.
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('This image format could not be opened in this browser.'));
      element.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('This image could not be converted.'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

/**
 * Returns { blob, dataUrl, width, height } for a picked File or Blob.
 *
 * The result is cached per file object so picking a photo, tagging it, and then
 * saving it does the encoding work only once.
 */
export async function prepareImage(file) {
  if (!isBlobLike(file)) {
    throw new Error('prepareImage expects an image File or Blob.');
  }

  const cached = prepared.get(file);
  if (cached) {
    return cached;
  }

  const work = (async () => {
    let source;
    try {
      source = await decode(file);
    } catch (error) {
      // Nothing local can read it; only pass it on if the API could cope.
      if (!API_SAFE_TYPES.has(file.type)) {
        throw new Error(
          `This browser cannot open ${file.type || 'that file type'}. Save the photo as a JPEG or PNG and try again.`,
        );
      }
      return { blob: file, dataUrl: await blobToDataUrl(file), width: 0, height: 0 };
    }

    const naturalWidth = source.width || source.naturalWidth;
    const naturalHeight = source.height || source.naturalHeight;
    const scale = Math.min(1, MAX_EDGE / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(source, 0, 0, width, height);
    source.close?.();

    const blob = await canvasToBlob(canvas);
    return { blob, dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY), width, height };
  })();

  prepared.set(file, work);
  try {
    const result = await work;
    prepared.set(file, Promise.resolve(result));
    return result;
  } catch (error) {
    prepared.delete(file);
    throw error;
  }
}
