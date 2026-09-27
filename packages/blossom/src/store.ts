/**
 * Content-addressed blob store on disk: `<dataDir>/blobs/<sha256>` plus one
 * JSON index of sizes, types and owners. A blob uploaded by two people is
 * stored once and counts against both quotas; deleting removes only the
 * caller's ownership, and the file goes when the last owner does.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

export interface BlobMeta {
  size: number;
  type: string;
  uploaded: number;
  owners: string[];
}

export class TooLargeError extends Error {}

export class BlobStore {
  readonly blobDir: string;
  private readonly indexPath: string;
  private readonly tmpDir: string;
  private index: Record<string, BlobMeta>;

  constructor(readonly dataDir: string) {
    this.blobDir = join(dataDir, 'blobs');
    this.tmpDir = join(dataDir, 'tmp');
    this.indexPath = join(dataDir, 'index.json');
    mkdirSync(this.blobDir, { recursive: true });
    rmSync(this.tmpDir, { recursive: true, force: true });
    mkdirSync(this.tmpDir, { recursive: true });
    this.index = existsSync(this.indexPath)
      ? (JSON.parse(readFileSync(this.indexPath, 'utf8')) as Record<string, BlobMeta>)
      : {};
  }

  get(sha256: string): BlobMeta | undefined {
    return this.index[sha256];
  }

  path(sha256: string): string {
    return join(this.blobDir, sha256);
  }

  count(): number {
    return Object.keys(this.index).length;
  }

  totalBytes(): number {
    let n = 0;
    for (const m of Object.values(this.index)) n += m.size;
    return n;
  }

  usageOf(pubkey: string): number {
    let n = 0;
    for (const m of Object.values(this.index)) if (m.owners.includes(pubkey)) n += m.size;
    return n;
  }

  listBy(pubkey: string): Array<[string, BlobMeta]> {
    return Object.entries(this.index)
      .filter(([, m]) => m.owners.includes(pubkey))
      .sort((a, b) => b[1].uploaded - a[1].uploaded);
  }

  freeBytes(): number {
    const s = statfsSync(this.dataDir);
    return Number(s.bavail) * Number(s.bsize);
  }

  /**
   * Stream `body` to a temp file, hashing as it goes. Aborts with
   * TooLargeError past `maxBytes`, so a lying Content-Length can't fill the disk.
   */
  async receive(body: Readable, maxBytes: number): Promise<{ tmp: string; sha256: string; size: number }> {
    const tmp = join(this.tmpDir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const hash = createHash('sha256');
    const out = createWriteStream(tmp);
    let size = 0;
    try {
      for await (const chunk of body) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > maxBytes) throw new TooLargeError(`blob exceeds ${maxBytes} bytes`);
        hash.update(buf);
        if (!out.write(buf)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      return { tmp, sha256: hash.digest('hex'), size };
    } catch (err) {
      out.destroy();
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  commit(tmp: string, sha256: string, meta: { size: number; type: string; owner: string; now?: number }): BlobMeta {
    const existing = this.index[sha256];
    if (existing) {
      rmSync(tmp, { force: true });
      if (!existing.owners.includes(meta.owner)) existing.owners.push(meta.owner);
    } else {
      renameSync(tmp, this.path(sha256));
      this.index[sha256] = {
        size: meta.size,
        type: meta.type,
        uploaded: meta.now ?? Math.floor(Date.now() / 1000),
        owners: [meta.owner],
      };
    }
    this.flush();
    return this.index[sha256];
  }

  discard(tmp: string): void {
    rmSync(tmp, { force: true });
  }

  /** Drop `owner`'s claim; returns false when they never owned it. */
  release(sha256: string, owner: string): boolean {
    const m = this.index[sha256];
    if (!m || !m.owners.includes(owner)) return false;
    m.owners = m.owners.filter((o) => o !== owner);
    if (m.owners.length === 0) {
      delete this.index[sha256];
      rmSync(this.path(sha256), { force: true });
    }
    this.flush();
    return true;
  }

  private flush(): void {
    writeFileSync(`${this.indexPath}.tmp`, JSON.stringify(this.index));
    renameSync(`${this.indexPath}.tmp`, this.indexPath);
  }
}
