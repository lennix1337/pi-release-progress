import { readdirSync, watch, type FSWatcher } from 'node:fs';

/**
 * Names matching `pattern` in each directory, without listing the directory on every scan.
 * Listing %TEMP% (tens of thousands of entries) costs megabytes of directory I/O per call, so a
 * directory is listed once and again only after its watcher reports a matching name (or loses
 * track). Without a watcher it is listed on every call, as before.
 */
export class StatusDirs {
  private readonly names = new Map<string, string[]>();
  private readonly stale = new Set<string>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly dirs: string[];
  private readonly pattern: RegExp;
  private readonly list: (dir: string) => string[];

  constructor(dirs: string[], pattern: RegExp, list: (dir: string) => string[] = (dir) => readdirSync(dir)) {
    this.dirs = dirs;
    this.pattern = pattern;
    this.list = list;
  }

  /** Matching names per directory; a directory that cannot be read is skipped. */
  entries(): { dir: string; names: string[] }[] {
    const result: { dir: string; names: string[] }[] = [];
    for (const dir of this.dirs) {
      let names = this.names.get(dir);
      if (!names || this.stale.has(dir) || !this.watchers.has(dir)) {
        try { names = this.list(dir).filter((name) => this.pattern.test(name)); } catch { this.names.delete(dir); continue; }
        this.names.set(dir, names);
        this.stale.delete(dir);
        this.watch(dir);
      }
      result.push({ dir, names });
    }
    return result;
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.names.clear();
    this.stale.clear();
  }

  private watch(dir: string): void {
    if (this.watchers.has(dir)) return;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (!name || this.pattern.test(String(name))) this.stale.add(dir);
      });
      watcher.on('error', () => { watcher.close(); this.watchers.delete(dir); });
      this.watchers.set(dir, watcher);
    } catch { /* no watcher: list on every call */ }
  }
}
