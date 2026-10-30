/**
 * Copies text. The hub is usually reached over plain http on a VPN address, which is not a
 * "secure context", so navigator.clipboard is missing there. The fallback selects a hidden
 * textarea and uses execCommand, which still works on such pages when called from a click.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission refused or unsupported: try the fallback.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  // On screen but invisible: iOS will not copy from an element that is display:none or off-screen.
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', opacity: '0', fontSize: '16px' });
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export type ImageCopyResult = 'copied' | 'unavailable' | 'failed';

function canWritePngImage(): boolean {
  const Item = globalThis.ClipboardItem;
  return typeof window !== 'undefined' && window.isSecureContext
    && typeof navigator !== 'undefined' && typeof navigator.clipboard?.write === 'function'
    && typeof Item !== 'undefined'
    && (typeof Item.supports !== 'function' || Item.supports('image/png'));
}

function hasLegacyCopySupport(): boolean {
  return typeof document !== 'undefined' && typeof document.execCommand === 'function';
}

function imageAsPng(url: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx || !canvas.width || !canvas.height) {
        reject(new Error('Cannot draw image'));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Cannot encode image'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Cannot load image'));
    img.src = url;
  });
}

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Cannot read image'));
    reader.onerror = () => reject(new Error('Cannot read image'));
    reader.readAsDataURL(blob);
  });
}

async function copyImageSelection(url: string): Promise<boolean> {
  if (!hasLegacyCopySupport()) return false;
  const png = await imageAsPng(url);
  const dataUrl = await blobAsDataUrl(png);
  const box = document.createElement('div');
  box.contentEditable = 'true';
  // Keep it selectable on-screen: some browsers refuse copying from display:none or off-screen nodes.
  Object.assign(box.style, { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none' });
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = '';
  box.appendChild(img);
  document.body.appendChild(box);
  const range = document.createRange();
  range.selectNode(img);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  try {
    return document.execCommand('copy');
  } finally {
    selection?.removeAllRanges();
    box.remove();
  }
}

/** Copies a displayed picture when the browser exposes the async image clipboard API. */
export async function copyImage(url: string): Promise<ImageCopyResult> {
  try {
    if (!canWritePngImage()) return await copyImageSelection(url) ? 'copied' : 'unavailable';
    const original = await (await fetch(url)).blob();
    // Browsers that can write images are consistently happiest with PNG clipboard items.
    const blob = original.type === 'image/png' ? original : await imageAsPng(url);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return 'copied';
  } catch {
    return 'failed';
  }
}
