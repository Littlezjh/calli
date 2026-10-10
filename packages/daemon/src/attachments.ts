import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './errors.js';

export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An image as sent to an agent: base64 data plus the type found in the bytes. */
export interface ImageInput {
  data: string;
  mimeType: string;
  /**
   * Where the hub keeps the file, for agents that are given a path rather than the bytes.
   * Set for images sent in a turn; absent for images read back from an agent's history.
   */
  path?: string;
}

/** The lines that tell an agent where the pictures of a message are, for agents that read them from disk. */
export function imagePathNote(images: ImageInput[]): string {
  const paths = images.map((img) => img.path).filter((p): p is string => Boolean(p));
  if (paths.length === 0) return '';
  return `\n\n${paths.length === 1 ? 'The user attached an image' : `The user attached ${paths.length} images`}. Look at ${paths.length === 1 ? 'it' : 'them'} before answering:\n${paths.map((p) => `- ${p}`).join('\n')}`;
}

/** What the event log keeps about an image. The bytes live on disk. */
export interface StoredAttachment {
  id: string;
  mimeType: string;
  size: number;
}

/**
 * Finds the image type from the first bytes of the data. The type the client claims is ignored,
 * so nothing other than a real PNG, JPEG, GIF or WebP can be stored and served back as an image.
 */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (buf.length >= 12 && head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Image files attached to turns, kept under `<dataDir>/attachments/<threadId>/`. */
export class AttachmentStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'attachments');
  }

  /**
   * Checks every image, then writes them all. Nothing is written if any one is rejected.
   * Returns the records for the event log and the images in the form adapters send to agents.
   */
  save(threadId: string, raw: unknown[]): { stored: StoredAttachment[]; images: ImageInput[] } {
    if (!UUID.test(threadId)) throw new HttpError(400, 'invalid thread id');
    const checked = this.check(raw);

    const dir = join(this.root, threadId);
    if (checked.length) mkdirSync(dir, { recursive: true });
    const stored: StoredAttachment[] = [];
    const images: ImageInput[] = [];
    for (const { bytes, mimeType } of checked) {
      const id = randomUUID();
      const path = join(dir, `${id}.${EXTENSIONS[mimeType]}`);
      writeFileSync(path, bytes);
      stored.push({ id, mimeType, size: bytes.length });
      images.push({ data: bytes.toString('base64'), mimeType, path });
    }
    return { stored, images };
  }

  /** Decodes and checks images without storing them. Throws on the first one that is not acceptable. */
  check(raw: unknown[]): Array<{ bytes: Buffer; mimeType: string }> {
    if (raw.length > MAX_IMAGES) throw new HttpError(400, `at most ${MAX_IMAGES} images per message`);
    return raw.map((item, i) => {
      const value = (item as { data?: unknown } | null)?.data;
      if (typeof value !== 'string' || !value) throw new HttpError(400, `image ${i + 1} has no data`);
      // Accept a data URL as well as bare base64.
      const base64 = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length === 0) throw new HttpError(400, `image ${i + 1} is empty`);
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new HttpError(413, `image ${i + 1} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
      }
      const mimeType = sniffImageType(bytes);
      if (!mimeType) throw new HttpError(400, `image ${i + 1} is not a PNG, JPEG, GIF or WebP file`);
      return { bytes, mimeType };
    });
  }

  /** Path and type of a stored image, or null. Ids are checked so they cannot escape the directory. */
  find(threadId: string, id: string): { path: string; mimeType: string; size: number } | null {
    if (!UUID.test(threadId) || !UUID.test(id)) return null;
    for (const [mimeType, ext] of Object.entries(EXTENSIONS)) {
      const path = join(this.root, threadId, `${id}.${ext}`);
      if (existsSync(path)) return { path, mimeType, size: statSync(path).size };
    }
    return null;
  }

  /** Gives a forked thread its own copy of the images, so deleting either thread leaves the other intact. */
  copyThread(fromThreadId: string, toThreadId: string): void {
    if (!UUID.test(fromThreadId) || !UUID.test(toThreadId)) return;
    const from = join(this.root, fromThreadId);
    if (existsSync(from)) cpSync(from, join(this.root, toThreadId), { recursive: true });
  }

  removeThread(threadId: string): void {
    if (!UUID.test(threadId)) return;
    rmSync(join(this.root, threadId), { recursive: true, force: true });
  }
}
