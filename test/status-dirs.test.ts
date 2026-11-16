import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StatusDirs } from '../src/status-dirs.ts';

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('an unchanged status directory is listed once, not on every discovery tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-release-dirs-'));
  let listed = 0;
  const dirs = new StatusDirs([dir], /release.*status.*\.json$/i, (d) => { listed++; return readdirSync(d); });
  try {
    for (let i = 0; i < 20; i++) dirs.entries();
    assert.equal(listed, 1);

    writeFileSync(join(dir, 'unrelated.log'), 'x');
    await new Promise((r) => setTimeout(r, 200));
    dirs.entries();
    assert.equal(listed, 1, 'churn of other files does not relist');

    writeFileSync(join(dir, 'gx-release-status.json'), '{}');
    let names: string[] = [];
    await until(() => (names = dirs.entries()[0]?.names ?? []).length > 0);
    assert.deepEqual(names, ['gx-release-status.json']);
  } finally {
    dirs.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing status directory is skipped', () => {
  const dirs = new StatusDirs([join(tmpdir(), 'pi-release-missing-dir-xyz')], /status/);
  assert.deepEqual(dirs.entries(), []);
  dirs.close();
});
