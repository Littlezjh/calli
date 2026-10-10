/** Preparing pictures for sending: checks, downscaling, base64. */

export const MAX_IMAGES = 6;
/** Longest edge after downscaling. Larger pictures gain nothing for a model and cost upload time. */
const MAX_EDGE = 2048;
/** Files at or under this size and edge limit are sent untouched. */
const PASS_THROUGH_BYTES = 1.5 * 1024 * 1024;
/** The daemon refuses images over 5 MB; stay clearly under it. */
const MAX_SEND_BYTES = 4.5 * 1024 * 1024;
const PASS_THROUGH_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export interface PreparedImage {
  /** Local id, for React keys and removal. */
  id: string;
  name: string;
  data: string;
  mimeType: string;
  /** Object URL for the thumbnail. The owner revokes it when the image is removed or sent. */
  previewUrl: string;
}

/** The size a picture is drawn at so that neither edge exceeds `max`, keeping its shape. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('无法读取这张图片'));
    img.src = url;
  });
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('无法读取这张图片'));
    reader.readAsDataURL(blob);
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('无法压缩这张图片'))), 'image/jpeg', quality);
  });
}

/**
 * Reads a picked, pasted or dropped file. Small pictures go as they are. Large ones (a phone photo
 * is often 3-8 MB) are scaled down and re-encoded as JPEG so they upload quickly over a VPN.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name || '这个文件'} 不是图片`);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const name = file.name || '图片';
  const originalUrl = URL.createObjectURL(file);

  let img: HTMLImageElement;
  try {
    img = await loadImage(originalUrl);
  } catch (err) {
    URL.revokeObjectURL(originalUrl);
    throw err;
  }

  const small = Math.max(img.naturalWidth, img.naturalHeight) <= MAX_EDGE && file.size <= PASS_THROUGH_BYTES;
  if (small && PASS_THROUGH_TYPES.includes(file.type)) {
    return { id, name, data: await toBase64(file), mimeType: file.type, previewUrl: originalUrl };
  }

  const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, MAX_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    URL.revokeObjectURL(originalUrl);
    throw new Error('无法压缩这张图片');
  }
  // JPEG has no transparency; without a fill, transparent areas of a screenshot would turn black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  URL.revokeObjectURL(originalUrl);

  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await canvasToJpeg(canvas, quality);
    if (blob.size <= MAX_SEND_BYTES) {
      return { id, name, data: await toBase64(blob), mimeType: 'image/jpeg', previewUrl: URL.createObjectURL(blob) };
    }
  }
  throw new Error(`${name} 压缩后仍然太大`);
}
