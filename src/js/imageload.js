// Image decoding helpers (off the main thread via createImageBitmap / ImageDecoder).

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', pjpeg: 'image/jpeg', pjp: 'image/jpeg',
  png: 'image/png', apng: 'image/apng', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};
const MAYBE_ANIMATED = new Set(['gif', 'webp', 'png', 'apng', 'avif']);

export const imageUrl = (path) => `gp://app/img?p=${encodeURIComponent(path)}`;

export function extOf(path) {
  const m = /\.([^.\\/]+)$/.exec(path);
  return m ? m[1].toLowerCase() : '';
}

export async function fetchBlob(path) {
  const res = await fetch(imageUrl(path));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const type = MIME_BY_EXT[extOf(path)];
  return type && blob.type !== type ? new Blob([blob], { type }) : blob;
}

async function bitmapViaImageElement(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 1024;
    return await createImageBitmap(img, { resizeWidth: w, resizeHeight: h });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode a blob to an ImageBitmap (EXIF orientation applied), limited to maxSize. */
export async function decodeBitmap(blob, maxSize = 0) {
  let full;
  try {
    full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    full = await bitmapViaImageElement(blob); // e.g. SVG
  }
  const fullSize = { w: full.width, h: full.height };
  const longEdge = Math.max(full.width, full.height);
  if (!maxSize || longEdge <= maxSize) return { bitmap: full, fullSize, isFull: true };
  const k = maxSize / longEdge;
  const small = await createImageBitmap(full, {
    resizeWidth: Math.max(1, Math.round(full.width * k)),
    resizeHeight: Math.max(1, Math.round(full.height * k)),
    resizeQuality: 'high',
  });
  full.close();
  return { bitmap: small, fullSize, isFull: false };
}

/** Returns an ImageDecoder if the blob is an animated image, else null. */
export async function animatedDecoder(blob, path) {
  if (!('ImageDecoder' in window) || !MAYBE_ANIMATED.has(extOf(path))) return null;
  try {
    if (!(await window.ImageDecoder.isTypeSupported(blob.type))) return null;
    const decoder = new window.ImageDecoder({ data: blob.stream(), type: blob.type });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (track && track.animated) {
      await decoder.completed.catch(() => {});
      if (track.frameCount > 1) return decoder;
    }
    decoder.close();
  } catch {
    // not decodable as animation
  }
  return null;
}

/** Plays an ImageDecoder animation, calling onFrame(VideoFrame) for each frame. */
export class AnimationPlayer {
  constructor(decoder, onFrame) {
    this.decoder = decoder;
    this.onFrame = onFrame;
    this.index = 0;
    this.frame = null;
    this.paused = false;
    this.disposed = false;
    this.timer = null;
  }

  get size() {
    return this.frame ? { w: this.frame.displayWidth, h: this.frame.displayHeight } : null;
  }

  async start() {
    await this._show(0);
    if (!this.paused) this._schedule();
  }

  async _show(index) {
    try {
      const { image } = await this.decoder.decode({ frameIndex: index });
      if (this.disposed) {
        image.close();
        return;
      }
      if (this.frame) this.frame.close();
      this.frame = image;
      this.index = index;
      this.onFrame(image);
    } catch {
      // decoding error: stop the animation
      this.paused = true;
    }
  }

  _schedule() {
    clearTimeout(this.timer);
    if (this.paused || this.disposed || !this.frame) return;
    const ms = Math.max(20, (this.frame.duration || 100000) / 1000);
    this.timer = setTimeout(async () => {
      const count = this.decoder.tracks.selectedTrack.frameCount;
      await this._show((this.index + 1) % count);
      this._schedule();
    }, ms);
  }

  setPaused(paused) {
    this.paused = paused;
    if (paused) clearTimeout(this.timer);
    else this._schedule();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    if (this.frame) this.frame.close();
    this.frame = null;
    try {
      this.decoder.close();
    } catch { /* already closed */ }
  }
}
