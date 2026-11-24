import { crc32, deflateRawSync } from 'node:zlib';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes `folder` as a ZIP archive at `zipFile`: every file, under the folder's own name, deflated. Written here,
 * with Node's zlib, rather than by a tool on the machine: `zip` is not on every machine, and Windows' built-in
 * tar crashes on OM's release. Paths use forward slashes, which every ZIP reader accepts.
 */
export async function writeZip(folder: string, zipFile: string): Promise<void> {
  const root = path.basename(folder);
  const files = await listFiles(folder);
  if (files.length >= 0xffff)
    throw new Error(`Too many files for a ZIP without ZIP64: ${files.length}`);
  const modified = new Date();
  const time =
    (modified.getHours() << 11) | (modified.getMinutes() << 5) | (modified.getSeconds() >> 1);
  const date =
    ((modified.getFullYear() - 1980) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const relative of files) {
    const data = await readFile(path.join(folder, relative));
    const body = deflateRawSync(data);
    const name = Buffer.from(`${root}/${relative}`, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // central directory entry
    entry.writeUInt16LE(0x031e, 4); // made by Unix, spec 3.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(zipFile, Buffer.concat([...parts, directory, end]));
}

/** Every regular file under `dir`, as forward-slash paths relative to it, in a stable order. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(dir, relative)));
    else if (entry.isFile()) found.push(relative);
    else throw new Error(`Not a regular file or folder, cannot archive it: ${relative}`);
  }
  return found;
}
