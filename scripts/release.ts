// Builds a release of OM that runs on Linux, macOS and Windows with only Node 26+ and git:
//
//   pnpm release   →   releases/om-<version>/   and   releases/om-<version>.tar.gz
//
// The release keeps the repository's layout, so the server finds the web app exactly as in
// development: the server's TypeScript (Node runs it directly, no build), the built web app,
// and one flat node_modules with the production dependencies. Those are plain JavaScript (the
// script refuses symlinks and native addons), so the same folder runs on every OS.
// Runs on every OS: Node APIs and child processes with argument arrays, no shell.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeZip } from './zip-archive.ts';

const ROOT = path.join(import.meta.dirname, '..');
const RELEASES = path.join(ROOT, 'releases');

/**
 * Runs the pnpm that runs `pnpm release` (`npm_execpath`): a JavaScript entry point through
 * Node, or pnpm's standalone executable directly. Never a `.cmd` shim, which needs a shell on
 * Windows.
 */
function pnpm(args: string[], cwd = ROOT): void {
  const cli = process.env['npm_execpath'];
  if (cli === undefined || cli === '') {
    throw new Error('Run this through pnpm: `pnpm release`.');
  }
  const isScript = /\.[cm]?js$/.test(cli);
  execFileSync(isScript ? process.execPath : cli, isScript ? [cli, ...args] : args, {
    cwd,
    stdio: 'inherit',
  });
}

/** `om-<git describe>`, e.g. `om-7b2b028` or `om-7b2b028-dirty` with uncommitted changes. */
function releaseName(): string {
  const describe = execFileSync('git', ['describe', '--always', '--dirty'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  return `om-${describe}`;
}

/** Every file and folder under `dir`, without following links. */
async function* walk(dir: string): AsyncGenerator<{ file: string; isLink: boolean }> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const isLink = (await lstat(file)).isSymbolicLink();
    yield { file, isLink };
    if (!isLink && entry.isDirectory()) yield* walk(file);
  }
}

/** Fails unless `node_modules` is portable: no symlinks (lost in archives), no native addons. */
async function assertPortable(nodeModules: string): Promise<void> {
  for await (const { file, isLink } of walk(nodeModules)) {
    const where = path.relative(nodeModules, file);
    if (isLink) throw new Error(`Not portable, a symlink: node_modules/${where}`);
    if (file.endsWith('.node')) throw new Error(`Not portable, a native addon: ${where}`);
  }
}

/**
 * The production dependencies, from the lockfile, as one flat folder (`node-linker=hoisted`,
 * no symlinks). pnpm's own bookkeeping and `.bin` shims (platform-specific) are dropped.
 */
async function installDependencies(out: string): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'om-release-deps-'));
  try {
    const deployed = path.join(scratch, 'server');
    pnpm(['--filter', '@om/server', 'deploy', '--prod', '--config.node-linker=hoisted', deployed]);
    const nodeModules = path.join(out, 'node_modules');
    await rename(path.join(deployed, 'node_modules'), nodeModules);
    for (const extra of ['.bin', '.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json']) {
      await rm(path.join(nodeModules, extra), { recursive: true, force: true });
    }
    // Node does not run TypeScript inside node_modules, so `@om/shared` points to its source,
    // which the release keeps in packages/shared (as in the repository).
    const shared = path.join(nodeModules, '@om', 'shared');
    await rm(shared, { recursive: true, force: true });
    await mkdir(shared, { recursive: true });
    await writeFile(
      path.join(shared, 'package.json'),
      `${JSON.stringify(
        {
          name: '@om/shared',
          private: true,
          type: 'module',
          exports: { '.': './index.js' },
        },
        undefined,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(shared, 'index.js'),
      "// Node runs TypeScript only outside node_modules: the source is in packages/shared.\nexport * from '../../../packages/shared/src/index.ts';\n",
    );
    await assertPortable(nodeModules);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const RUNNING = `# OM release

Runs on Linux, macOS and Windows. Needs:

- Node.js 26 or later (\`node -v\`)
- git (\`git --version\`)

Nothing to install or build. From this folder:

    node start.ts

It listens on port 49991 on every network interface, so other machines on your network can open it at
http://<this machine>:49991, and this one at http://127.0.0.1:49991. Only run it on a network you trust:
anyone who can reach OM can read the folders and repositories it holds.

## Run it on another machine

1. Copy the archive there. On Windows, \`om-<version>.tar.gz\` extracts with the built-in \`tar\` (\`tar -xzf om-<version>.tar.gz\`); the \`.zip\` extracts with File Explorer or 7-Zip. (The built-in \`tar\` cannot read one test fixture folder in the zip, whose name has a non-ASCII character. It is not needed to run OM.)
2. Install **Node.js 26 or later** (https://nodejs.org) and **git** (https://git-scm.com).
3. Extract the archive to a folder you can write to. Keep it there: OM keeps its data in \`.data\` inside the folder.
4. Open a terminal in that folder and run \`node start.ts\`. Windows: PowerShell or Command Prompt. macOS or Linux: any shell.
5. Allow the connection if the firewall asks (Windows: allow on private networks).
6. On the machine itself, open http://127.0.0.1:49991. From another machine on the same network, open
   http://<address of that machine>:49991. Find the address with \`ipconfig\` (Windows) or \`ip addr\`
   (Linux) or \`ipconfig getifaddr en0\` (macOS).
7. Stop OM with Ctrl+C. Start it again the same way.

To update, extract a newer release into a new folder and copy the \`.data\` folder across, so your
sessions and clones come with you (or point \`OM_DATA_DIR\` at a folder that survives the update).

Settings, as command-line flags or environment variables (a flag wins):

- \`--port <n>\` or \`API_PORT\`: port (default 49991)
- \`--host <address>\` or \`HOST\`: bind address (default 0.0.0.0, every interface; \`127.0.0.1\` keeps it on
  this machine only)
- \`OM_DATA_DIR\`: database and clones (default \`.data\` in this folder). Set it to keep your
  sessions when you replace this folder with a newer release.

For example, on this machine only, on port 6000: \`node start.ts --host 127.0.0.1 --port 6000\`.
`;

/**
 * What \`node start.ts\` runs: the server in production mode, with the release defaults (port 49991, every
 * interface). The defaults apply only where nothing else set them, so \`API_PORT\`, \`HOST\` and the flags win.
 */
const LAUNCHER = `// OM's release start. Defaults: port 49991, every network interface. API_PORT, HOST, --port and --host override them.
process.env.API_PORT ??= '49991';
process.env.HOST ??= '0.0.0.0';
process.argv.push('--production');
await import('./apps/server/src/index.ts');
`;

/** Copies what the release runs: server and shared source, the built web app. */
async function copySources(out: string): Promise<void> {
  const copies = [
    ['apps', 'server', 'src'],
    ['apps', 'server', 'package.json'],
    ['packages', 'shared', 'src'],
    ['packages', 'shared', 'package.json'],
    ['apps', 'web', 'dist'],
  ];
  for (const parts of copies) {
    await cp(path.join(ROOT, ...parts), path.join(out, ...parts), { recursive: true });
  }
  const manifest = {
    name: 'om',
    private: true,
    type: 'module',
    engines: { node: '>=26' },
    scripts: { start: 'node start.ts' },
  };
  await writeFile(path.join(out, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);
  await writeFile(path.join(out, 'README.md'), RUNNING);
  await writeFile(path.join(out, 'start.ts'), LAUNCHER);
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (address === null || typeof address === 'string') throw new Error('No free port found');
  return address.port;
}

/** Starts the release as a user would, and checks that the web app and the API answer. */
async function smokeTest(out: string): Promise<void> {
  const port = await freePort();
  const data = await mkdtemp(path.join(tmpdir(), 'om-release-data-'));
  const child = spawn(
    process.execPath,
    [path.join('apps', 'server', 'src', 'index.ts'), '--production'],
    {
      cwd: out,
      env: { ...process.env, API_PORT: String(port), HOST: '127.0.0.1', OM_DATA_DIR: data },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = once(child, 'exit');
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`The release exited:\n${output}`);
      try {
        const page = await fetch(`${base}/`);
        if (page.ok && (await page.text()).includes('id="root"')) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error(`The release did not start:\n${output}`);
      await sleep(250);
    }
    const api = await fetch(`${base}/api/users/release-check/sessions`);
    if (!api.ok) throw new Error(`The API answered ${api.status}:\n${output}`);
  } finally {
    child.kill();
    await exited;
    await rm(data, { recursive: true, force: true });
  }
}

const name = releaseName();
const out = path.join(RELEASES, name);
process.stdout.write(`Building ${name}…\n`);
pnpm(['build']);
await rm(out, { recursive: true, force: true });
await rm(`${out}.tar.gz`, { force: true });
await mkdir(out, { recursive: true });
await copySources(out);
await installDependencies(out);
process.stdout.write('Starting the release to check it…\n');
await smokeTest(out);
// tar ships with Linux, macOS and Windows 10+. Relative paths only, so every tar agrees.
execFileSync('tar', ['-czf', `${name}.tar.gz`, name], { cwd: RELEASES, stdio: 'inherit' });
// A zip too, for Windows users who extract with Explorer. Written by Node (see zip-archive.ts).
await rm(`${out}.zip`, { force: true });
await writeZip(out, `${out}.zip`);
process.stdout.write(
  `\nRelease ready:\n  ${out}\n  ${out}.tar.gz\n  ${out}.zip\n\nRun it from that folder with: node start.ts\n`,
);
