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

    node apps/server/src/index.ts --production

Then open http://127.0.0.1:5181.

Settings are environment variables:

- \`API_PORT\`: port (default 5181)
- \`HOST\`: bind address (default 127.0.0.1; OM reads local paths and runs git, so keep it on
  loopback unless you trust the network)
- \`OM_DATA_DIR\`: database and clones (default \`.data\` in this folder). Set it to keep your
  sessions when you replace this folder with a newer release.
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
    scripts: { start: 'node apps/server/src/index.ts --production' },
  };
  await writeFile(path.join(out, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);
  await writeFile(path.join(out, 'README.md'), RUNNING);
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
process.stdout.write(
  `\nRelease ready:\n  ${out}\n  ${out}.tar.gz\n\nRun it from that folder with: node apps/server/src/index.ts --production\n`,
);
