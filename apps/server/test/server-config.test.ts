import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config/server-config.ts';

const repoRoot = path.join(path.parse(process.cwd()).root, 'repo');

describe('loadServerConfig', () => {
  it('defaults to loopback, port 5181 and .data', () => {
    expect(loadServerConfig({}, [], repoRoot)).toEqual({
      ok: true,
      value: {
        port: 5181,
        host: '127.0.0.1',
        isProduction: false,
        dataDir: path.join(repoRoot, '.data'),
        limits: { sessionsPerUser: 10, reposPerSession: 10, remotesPerRepo: 10 },
        cacheMaxBytes: 256 * 1024 * 1024,
      },
    });
  });

  it('reads the analysis cache size in megabytes, and refuses zero', () => {
    expect(loadServerConfig({ OM_CACHE_MAX_MB: '8' }, [], repoRoot)).toMatchObject({
      ok: true,
      value: { cacheMaxBytes: 8 * 1024 * 1024 },
    });
    expect(loadServerConfig({ OM_CACHE_MAX_MB: '0' }, [], repoRoot).ok).toBe(false);
  });

  it('reads the limits from the environment, and refuses a limit below 1', () => {
    const limits = loadServerConfig(
      {
        OM_MAX_SESSIONS_PER_USER: '3',
        OM_MAX_REPOS_PER_SESSION: '4',
        OM_MAX_REMOTES_PER_REPO: '5',
      },
      [],
      repoRoot,
    );
    expect(limits).toMatchObject({
      ok: true,
      value: { limits: { sessionsPerUser: 3, reposPerSession: 4, remotesPerRepo: 5 } },
    });
    const zero = loadServerConfig({ OM_MAX_REPOS_PER_SESSION: '0' }, [], repoRoot);
    expect(zero.ok).toBe(false);
  });

  it('reads overrides from the environment', () => {
    const result = loadServerConfig(
      {
        API_PORT: '6000',
        HOST: '0.0.0.0',
        OM_DATA_DIR: '/d',
      },
      [],
      repoRoot,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        port: 6000,
        host: '0.0.0.0',
        dataDir: '/d',
      },
    });
  });

  it('is in production mode with --production or NODE_ENV=production', () => {
    expect(loadServerConfig({}, ['--production'], repoRoot)).toMatchObject({
      value: { isProduction: true },
    });
    expect(loadServerConfig({ NODE_ENV: 'production' }, [], repoRoot)).toMatchObject({
      value: { isProduction: true },
    });
  });

  it('ignores PORT, which the preview runner sets for the web app', () => {
    expect(loadServerConfig({ PORT: '5180' }, [], repoRoot)).toMatchObject({
      value: { port: 5181 },
    });
  });

  it.each(['abc', '0', '70000', '1.5'])('returns an error for API_PORT=%s', (port) => {
    const result = loadServerConfig({ API_PORT: port }, [], repoRoot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/API_PORT/);
  });
});
