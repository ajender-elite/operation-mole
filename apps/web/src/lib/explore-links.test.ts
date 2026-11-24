import type { GitSource } from '@om/shared';
import { describe, expect, it } from 'vitest';
import { exploreLinks } from './explore-links.ts';
import { refParams, refSourceFromParams } from './sources.ts';
import { branchesUrl, codeUrl, commitsUrl, seriesUrl } from './urls.ts';

const SOURCE: GitSource = { type: 'git', repoId: 'r1', branch: 'stable-1.28', remote: 'upstream' };
const BASE = '/u/karthik/s/s1';

describe('refSourceFromParams and refParams', () => {
  it('read and write a repo ref, with the remote when there is one', () => {
    expect(refSourceFromParams(refParams(SOURCE))).toEqual(SOURCE);
    const plain = refParams({ type: 'git', repoId: 'r1', branch: 'main' });
    expect(refSourceFromParams(plain)).toEqual({ type: 'git', repoId: 'r1', branch: 'main' });
  });

  it('gives nothing for a link without a repo or a ref', () => {
    expect(refSourceFromParams(new URLSearchParams('repo=r1'))).toBeUndefined();
    expect(refSourceFromParams(new URLSearchParams('ref=main'))).toBeUndefined();
  });
});

describe('explorer URLs', () => {
  it('builds the Code and Commits URLs with the path and extra values', () => {
    expect(codeUrl('karthik', 's1', SOURCE, { path: 'src/a.c', lines: '2' })).toBe(
      `${BASE}/code?repo=r1&ref=stable-1.28&remote=upstream&path=src%2Fa.c&lines=2`,
    );
    expect(commitsUrl('karthik', 's1', SOURCE, { path: 'src' })).toBe(
      `${BASE}/commits?repo=r1&ref=stable-1.28&remote=upstream&path=src`,
    );
  });

  it('builds the Branches URL for the repo', () => {
    expect(branchesUrl('karthik', 's1', 'r1')).toBe(`${BASE}/branches?repo=r1`);
  });

  it('builds the Series URL with its picks in order and each branch as remote/branch', () => {
    expect(
      seriesUrl('karthik', 's1', 'r1', ['aaa', 'bbb'], [{ remote: 'origin', branch: 'feature/x' }]),
    ).toBe(`${BASE}/series?repo=r1&picks=aaa%2Cbbb&onto=origin%2Ffeature%2Fx`);
    expect(seriesUrl('karthik', 's1', 'r1', [])).toBe(`${BASE}/series?repo=r1`);
  });

  it('offers the five explorer tabs, marking the current one', () => {
    const links = exploreLinks('karthik', 's1', SOURCE, 'commits');
    expect(links.map((l) => l.label)).toEqual(['Code', 'Commits', 'Search', 'Branches', 'Series']);
    expect(links.filter((l) => l.isCurrent).map((l) => l.label)).toEqual(['Commits']);
  });
});
