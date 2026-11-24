import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync, crc32 } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { writeZip } from './zip-archive.ts';

/** Reads a ZIP the way a reader does: the end record, then each central entry and its local data. */
function readZip(zip: Buffer): Map<string, { text: string; crcOk: boolean }> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = new Map<string, { text: string; crcOk: boolean }>();
  for (let i = 0; i < count; i += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const local = localAt;
    const compressed = zip.readUInt32LE(local + 18);
    const localNameLength = zip.readUInt16LE(local + 26);
    const dataAt = local + 30 + localNameLength;
    const data = inflateRawSync(zip.subarray(dataAt, dataAt + compressed));
    entries.set(name, {
      text: data.toString('utf8'),
      crcOk: crc32(data) === crc && data.length === size,
    });
    at += 46 + nameLength;
  }
  return entries;
}

let scratch: string | undefined;
afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('writeZip', () => {
  it('archives every file under the folder name, deflated, with checksums that match', async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'om-zip-test-'));
    const folder = path.join(scratch, 'om-1.0');
    await mkdir(path.join(folder, 'apps', 'server'), { recursive: true });
    await writeFile(path.join(folder, 'README.md'), '# OM\n'.repeat(200));
    await writeFile(path.join(folder, 'apps', 'server', 'index.ts'), 'export {};\n');
    await writeFile(path.join(folder, 'empty.txt'), '');
    const zipFile = path.join(scratch, 'om-1.0.zip');

    await writeZip(folder, zipFile);

    const read = readZip(await readFile(zipFile));
    expect([...read.keys()].sort()).toEqual([
      'om-1.0/README.md',
      'om-1.0/apps/server/index.ts',
      'om-1.0/empty.txt',
    ]);
    expect(read.get('om-1.0/README.md')).toEqual({ text: '# OM\n'.repeat(200), crcOk: true });
    expect(read.get('om-1.0/apps/server/index.ts')).toEqual({ text: 'export {};\n', crcOk: true });
    expect(read.get('om-1.0/empty.txt')).toEqual({ text: '', crcOk: true });
  });
});
