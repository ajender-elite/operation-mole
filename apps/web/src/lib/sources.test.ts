import { describe, expect, it } from 'vitest';
import { sourceFromParams, sourceLabel, sourcesSearch } from './sources.ts';

describe('sourceFromParams', () => {
  it('reads a git repo and branch', () => {
    const params = new URLSearchParams('rightRepo=r1&rightBranch=feature%2Fx');
    expect(sourceFromParams(params, 'right')).toEqual({
      type: 'git',
      repoId: 'r1',
      branch: 'feature/x',
    });
  });

  it('ignores a local folder path, which the UI no longer compares', () => {
    expect(sourceFromParams(new URLSearchParams('left=%2Fa'), 'left')).toBeUndefined();
  });

  it('returns undefined when the side is missing or incomplete', () => {
    expect(sourceFromParams(new URLSearchParams(''), 'left')).toBeUndefined();
    expect(sourceFromParams(new URLSearchParams('leftRepo=r1'), 'left')).toBeUndefined();
  });
});

describe('sourcesSearch', () => {
  it('writes both sides and round-trips', () => {
    const left = { type: 'git' as const, repoId: 'r1', branch: 'main' };
    const right = { type: 'git' as const, repoId: 'r2', branch: 'dev' };
    const search = sourcesSearch(left, right);
    expect(search).toBe('?leftRepo=r1&leftBranch=main&rightRepo=r2&rightBranch=dev');
    const params = new URLSearchParams(search);
    expect(sourceFromParams(params, 'left')).toEqual(left);
    expect(sourceFromParams(params, 'right')).toEqual(right);
  });
});

describe('sourceLabel', () => {
  const repos = [{ id: 'r1', name: 'app' }];
  it('names a source by repo and branch', () => {
    expect(sourceLabel({ type: 'git', repoId: 'r1', branch: 'dev' }, repos)).toBe('app @ dev');
    expect(sourceLabel({ type: 'git', repoId: 'gone', branch: 'dev' }, repos)).toBe(
      'unknown repo @ dev',
    );
  });
});
