import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * What this machine's file system can do. Tests depend on these probes, not on
 * `process.platform`, so they run wherever the feature works and skip (with a reason)
 * where it doesn't:
 * - Windows creates symlinks only with Developer Mode or admin rights.
 * - `chmod 000` doesn't stop reading on Windows, nor for root on Linux/macOS.
 */
const probeDir = await mkdtemp(path.join(tmpdir(), 'om-probe-'));

async function probe(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

export const canCreateSymlinks = await probe(async () => {
  await symlink('target', path.join(probeDir, 'link'));
  return true;
});

export const canMakeFilesUnreadable = await probe(async () => {
  const file = path.join(probeDir, 'locked');
  await writeFile(file, 'x');
  await chmod(file, 0o000);
  try {
    await readFile(file);
    return false;
  } catch {
    return true;
  } finally {
    await chmod(file, 0o644);
  }
});

await rm(probeDir, { recursive: true, force: true });
