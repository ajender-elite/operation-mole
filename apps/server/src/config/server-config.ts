import path from 'node:path';
import type { ServerLimits } from '@om/shared';
import { z } from 'zod';
import type { Result } from '../result.ts';

/** Settings the server starts with. Built only by {@link loadServerConfig}. */
export type ServerConfig = {
  readonly port: number;
  readonly host: string;
  /** Serve the built web app from `apps/web/dist` too. */
  readonly isProduction: boolean;
  /** Sessions, cloned repos and the database. */
  readonly dataDir: string;
  /** How many sessions, repos and remotes there may be (enforced on the server). */
  readonly limits: ServerLimits;
  /** Most cached analysis results each user keeps on disk, in bytes (least recently used go first). */
  readonly cacheMaxBytes: number;
};

const DEFAULT_API_PORT = 5181;

/** A TCP port: a whole number from 1 to 65535. */
const PortSchema = z.coerce.number().int().min(1).max(65_535);

/** The limits when no `OM_MAX_*` setting says otherwise. */
export const DEFAULT_LIMITS: ServerLimits = {
  sessionsPerUser: 10,
  reposPerSession: 10,
  remotesPerRepo: 10,
};

/** A positive whole number of the given default: the value of a limit variable. */
const limitVariable = (fallback: number) =>
  z.coerce.number().int().min(1).max(10_000).default(fallback);

/**
 * The environment variables OM reads. `API_PORT`, not `PORT`: the preview runner sets
 * `PORT` for the web app, so reading it would put the API on the web app's port.
 */
const EnvSchema = z.object({
  API_PORT: PortSchema.default(DEFAULT_API_PORT),
  // Local tool with filesystem access: bind to loopback unless told otherwise.
  HOST: z.string().min(1).default('127.0.0.1'),
  NODE_ENV: z.string().optional(),
  OM_DATA_DIR: z.string().min(1).optional(),
  OM_MAX_SESSIONS_PER_USER: limitVariable(DEFAULT_LIMITS.sessionsPerUser),
  OM_MAX_REPOS_PER_SESSION: limitVariable(DEFAULT_LIMITS.reposPerSession),
  OM_MAX_REMOTES_PER_REPO: limitVariable(DEFAULT_LIMITS.remotesPerRepo),
  /** The analysis cache's size per user, in megabytes. */
  OM_CACHE_MAX_MB: z.coerce.number().int().min(1).max(100_000).default(256),
});

/**
 * The value of a command-line flag, as `--name value` or `--name=value`: undefined when the flag is absent, null
 * when it has no value, and the value otherwise.
 */
function flagValue(argv: readonly string[], name: string): string | null | undefined {
  const flag = `--${name}`;
  const index = argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index < 0) return undefined;
  const arg = argv[index] ?? '';
  const value = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : argv[index + 1];
  if (value === undefined || value === '' || value.startsWith('--')) return null;
  return value;
}

/**
 * The port the command line asks for (`--port 6000`), or undefined when it does not. It wins over `API_PORT`, so
 * one start can use another port without changing the environment.
 */
function portFlag(argv: readonly string[]): Result<number | undefined> {
  const value = flagValue(argv, 'port');
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = PortSchema.safeParse(value ?? '');
  if (!parsed.success) {
    return { ok: false, error: new Error('--port must be a port number from 1 to 65535') };
  }
  return { ok: true, value: parsed.data };
}

/**
 * The address the command line asks for (`--host 0.0.0.0`), or undefined when it does not. It wins over `HOST`.
 * `0.0.0.0` listens on every network interface, so anyone on the network can reach OM (and the folders it reads).
 */
function hostFlag(argv: readonly string[]): Result<string | undefined> {
  const value = flagValue(argv, 'host');
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null)
    return { ok: false, error: new Error('--host needs an address, for example 0.0.0.0') };
  return { ok: true, value };
}

/** Whether an address only accepts connections from this machine (loopback). */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Validates the server's environment and command-line flags.
 *
 * @param env - Usually `process.env`.
 * @param argv - Usually `process.argv`. `--production` turns on production mode; it replaces
 *   `NODE_ENV=production node …`, which only works in POSIX shells (npm uses cmd.exe on Windows).
 * @param repoRoot - Absolute path of the repository, for the default data folder.
 * @returns The config, or an error naming the invalid variable.
 */
export function loadServerConfig(
  env: Readonly<Record<string, string | undefined>>,
  argv: readonly string[],
  repoRoot: string,
): Result<ServerConfig> {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return { ok: false, error: new Error(`Invalid environment: ${problems.join('; ')}`) };
  }
  const vars = parsed.data;
  const port = portFlag(argv);
  if (!port.ok) return port;
  const host = hostFlag(argv);
  if (!host.ok) return host;
  return {
    ok: true,
    value: {
      port: port.value ?? vars.API_PORT,
      host: host.value ?? vars.HOST,
      isProduction: argv.includes('--production') || vars.NODE_ENV === 'production',
      dataDir: vars.OM_DATA_DIR ?? path.join(repoRoot, '.data'),
      limits: {
        sessionsPerUser: vars.OM_MAX_SESSIONS_PER_USER,
        reposPerSession: vars.OM_MAX_REPOS_PER_SESSION,
        remotesPerRepo: vars.OM_MAX_REMOTES_PER_REPO,
      },
      cacheMaxBytes: vars.OM_CACHE_MAX_MB * 1024 * 1024,
    },
  };
}
