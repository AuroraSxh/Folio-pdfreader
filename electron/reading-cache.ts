import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './store';

/** Only reusable evidence notes derived from PDF text, never keys or chat history. */
export class ReadingCacheStore {
  constructor(private root: string) {}
  private directory(workspaceId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workspaceId)) throw new Error('Invalid workspace ID');
    return path.join(this.root, workspaceId, '.reading-cache');
  }
  private file(workspaceId: string, key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid cache key');
    return path.join(this.directory(workspaceId), key + '.json');
  }
  async get(workspaceId: string, key: string): Promise<string | undefined> {
    try {
      const file = this.file(workspaceId, key);
      const stat = await fs.stat(file);
      if (stat.size > 128_000) return;
      const entry = JSON.parse(await fs.readFile(file, 'utf8'));
      if (entry.version === 1 && typeof entry.text === 'string' && entry.text.trim() && entry.text.length <= 24_000) return entry.text;
    } catch { /* Missing or invalid caches are rebuilt on demand. */ }
  }
  async set(workspaceId: string, key: string, text: string): Promise<void> {
    if (!text.trim() || text.length > 24_000) return;
    const file = this.file(workspaceId, key), directory = this.directory(workspaceId);
    await fs.mkdir(directory, { recursive: true });
    await atomicWrite(file, JSON.stringify({ version: 1, text }));
    // A bounded per-paper cache follows the paper through removal/restoration.
    const names = (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length > 256) {
      const entries = await Promise.all(names.map(async name => ({ name, time: (await fs.stat(path.join(directory, name))).mtimeMs })));
      entries.sort((a, b) => a.time - b.time);
      await Promise.all(entries.slice(0, entries.length - 256).map(entry => fs.rm(path.join(directory, entry.name), { force: true })));
    }
  }
}
