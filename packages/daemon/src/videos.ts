import { open, rename, rm, writeFile } from 'node:fs/promises';
import { HttpError } from './errors.js';

export const MAX_VIDEOS = 3;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const VIDEO_EXTENSIONS: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

/** Container signatures, not the browser's claimed MIME type or file extension. */
export function sniffVideoType(head: Buffer): string | null {
  if (head.length >= 16 && head.toString('ascii', 4, 8) === 'ftyp') {
    const end = Math.min(head.readUInt32BE(0), head.length);
    if (end < 16) return null;
    const brands = [head.toString('ascii', 8, 12)];
    for (let i = 16; i + 4 <= end; i += 4) brands.push(head.toString('ascii', i, i + 4));
    if (brands.some(b => /^(avif|avis|heic|heix|mif1|msf1)$/.test(b))) return null;
    if (brands.includes('qt  ')) return 'video/quicktime';
    if (brands.some(b => /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash)$/.test(b))) return 'video/mp4';
  }
  if (head.length >= 8 && head.readUInt32BE(0) === 0x1a45dfa3 && head.includes(Buffer.from('webm'))) return 'video/webm';
  return null;
}

/** Stream to a private partial file, then publish only a validated, complete upload. */
export async function storeVideo(base: string, source: AsyncIterable<Uint8Array>, name: string): Promise<{ mimeType: string; size: number; name: string }> {
  const partial = `${base}.part`;
  const file = await open(partial, 'wx', 0o600);
  let size = 0;
  let head = Buffer.alloc(0);
  let destination: string | undefined;
  try {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > MAX_VIDEO_BYTES) throw new HttpError(413, '视频不能超过 100 MB');
      if (head.length < 4096) head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
      await file.writeFile(chunk);
    }
    const mimeType = sniffVideoType(head);
    if (!mimeType) throw new HttpError(400, '请选择 MP4、MOV 或 WebM 视频');
    const cleanName = name.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
    const info = { mimeType, size, name: cleanName || `视频.${VIDEO_EXTENSIONS[mimeType]}` };
    destination = `${base}.${VIDEO_EXTENSIONS[mimeType]}`;
    await file.close();
    await rename(partial, destination);
    await writeFile(`${base}.json`, JSON.stringify(info), { mode: 0o600 });
    return info;
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(partial, { force: true });
    if (destination) await rm(destination, { force: true });
    await rm(`${base}.json`, { force: true });
    throw error;
  }
}
