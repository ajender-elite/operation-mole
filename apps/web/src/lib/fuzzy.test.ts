import { describe, expect, it } from 'vitest';
import { fuzzyScore, rankPaths } from './fuzzy.ts';

describe('fuzzyScore', () => {
  it('matches the letters of the query in order, anywhere in the path', () => {
    expect(fuzzyScore('ngxcore', 'src/http/ngx_http_core_module.c')).toBeDefined();
    expect(fuzzyScore('cm', 'src/core/main.c')).toBeDefined();
  });

  it('refuses a query whose letters do not appear in order', () => {
    expect(fuzzyScore('cba', 'abc.txt')).toBeUndefined();
    expect(fuzzyScore('zz', 'src/main.c')).toBeUndefined();
  });

  it('ranks a name that starts with the query above one where it is buried', () => {
    const starts = fuzzyScore('main', 'main.c') ?? Number.NEGATIVE_INFINITY;
    const buried = fuzzyScore('main', 'src/some/long/path/domain.txt') ?? Number.NEGATIVE_INFINITY;
    expect(starts).toBeGreaterThan(buried);
  });

  it('ranks a match on the file name above one only in the folders', () => {
    const inName = fuzzyScore('http', 'src/x/http.c') ?? 0;
    const inFolder = fuzzyScore('http', 'src/http/x.c') ?? 0;
    expect(inName).toBeGreaterThan(inFolder);
  });

  it('ignores case', () => {
    expect(fuzzyScore('MAIN', 'src/main.c')).toBeDefined();
  });
});

describe('rankPaths', () => {
  const paths = ['docs/guide.md', 'src/main.c', 'src/http/main_core.c', 'README.md'];

  it('shows every path, in order, for an empty query', () => {
    expect(rankPaths(paths, '', 10)).toEqual(paths);
  });

  it('lists the best matches first, and only those that match', () => {
    expect(rankPaths(paths, 'main', 10)).toEqual(['src/main.c', 'src/http/main_core.c']);
  });

  it('keeps at most the limit', () => {
    expect(rankPaths(paths, '', 2)).toEqual(['docs/guide.md', 'src/main.c']);
  });
});
