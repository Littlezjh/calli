import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x as extractTar } from 'tar';
import { homeDirectory } from './config.js';
import { HttpError } from './errors.js';

/**
 * The desk's companion. Its frames are MIT artwork (see LICENSE.txt next to the bundled archive).
 * Only the clips the desk plays are shipped, every other frame. Installation unpacks them locally
 * into the Calli home directory; it never needs GitHub or any other network service.
 */
export const PET = {
  id: 'dafeiyu',
  repo: 'QCYTSN/dsh-dafeiyu',
  commit: '084323845ab82b68d5388d5c638bec09d8544a8a',
  /** Frames per clip in the source; the desk keeps the odd ones and plays them at 12 fps. */
  clips: { idle: 241, thinking: 241, success: 241, poke: 241, head_pat: 241, idle_yawn: 241 } as Record<string, number>,
  archiveSha256: '40c86a4c923f47d7c637a72cf2a33ada0b43bab5b60df25b6e0a3c041092ce34',
};

export type PetClip = keyof typeof PET.clips;
export interface PetStatus { id: string; commit: string; installed: boolean; installing: boolean; error: string | null; clips: Record<string, number>; frameMs: number }

const FRAME = /^\/pets\/([a-z0-9_-]+)\/([a-z_]+)\/([a-z_]+_\d{3})\.webp$/;
const ARCHIVE = fileURLToPath(new URL('../assets/pets/dafeiyu-0843238.tar.gz', import.meta.url));

/** Frames kept for a clip: the source's odd-numbered ones. */
export const keptFrames = (count: number): number => Math.ceil(count / 2);

export class PetService {
  private installing: Promise<void> | null = null;
  private error: string | null = null;
  constructor(
    private readonly root = join(homeDirectory(), 'pets'),
    private readonly archive = ARCHIVE,
  ) {}

  private dir(): string { return join(this.root, PET.id); }
  private marker(): string { return join(this.dir(), 'INSTALLED'); }
  private installed(): boolean { return existsSync(this.marker()) && readFileSync(this.marker(), 'utf8').trim() === PET.commit; }

  status(): PetStatus {
    return {
      id: PET.id,
      commit: PET.commit,
      installed: this.installed(),
      installing: Boolean(this.installing),
      error: this.error,
      clips: Object.fromEntries(Object.entries(PET.clips).map(([clip, count]) => [clip, keptFrames(count)])),
      frameMs: 84,
    };
  }

  /** Unpacks the bundled frames once; concurrent callers join the same installation. */
  install(): Promise<void> {
    if (this.installed()) return Promise.resolve();
    this.installing ??= this.unpack().then(
      () => { this.error = null; },
      (e: unknown) => { this.error = e instanceof Error ? e.message : String(e); throw e; },
    ).finally(() => { this.installing = null; });
    return this.installing;
  }

  private async unpack(): Promise<void> {
    // Built beside the final directory and moved in whole, so a half-finished installation never shows.
    const staging = `${this.dir()}.partial`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(this.archive)) hash.update(chunk);
      if (hash.digest('hex') !== PET.archiveSha256) throw new HttpError(500, 'bundled pet archive checksum mismatch; reinstall Calli');
      await extractTar({ file: this.archive, cwd: staging, strip: 1, strict: true, noChmod: true });
      writeFileSync(join(staging, 'INSTALLED'), `${PET.commit}\n`);
      rmSync(this.dir(), { recursive: true, force: true });
      renameSync(staging, this.dir());
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /** Serves `/pets/<id>/<clip>/<frame>.webp`. Public like the web build: it is artwork, not user data. */
  serve(path: string, res: ServerResponse): boolean {
    const match = FRAME.exec(path);
    if (!match) return false;
    const [, id, clip, name] = match;
    const file = join(this.dir(), clip, `${name}.webp`);
    if (id !== PET.id || !(clip in PET.clips) || !name.startsWith(`${clip}_`) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' });
    createReadStream(file).pipe(res);
    return true;
  }

  /** The license that came with the frames, for the about line. */
  license(): string | null {
    const file = join(this.dir(), 'LICENSE.txt');
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
}
