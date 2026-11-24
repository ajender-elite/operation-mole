import { describe, expect, it } from 'vitest';
import {
  loadTabs,
  saveTabs,
  syncTabs,
  tabIdentity,
  tabKind,
  type WorkspaceTab,
} from './workspace.ts';

const BASE = '/u/kim/s/s1';
const FOLDERS = `${BASE}/folders?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev`;
const FILE = (path: string, commits = ['a', 'b']) =>
  `${BASE}/file?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev&leftCommit=${commits[0] ?? ''}&rightCommit=${commits[1] ?? ''}&leftPath=${path}&rightPath=${path}`;

describe('tabIdentity', () => {
  it('names the overview, and nothing outside the session', () => {
    expect(tabIdentity(BASE, BASE)).toBe('home');
    expect(tabIdentity('/u/kim', BASE)).toBeUndefined();
    expect(tabIdentity(`${BASE}/elsewhere`, BASE)).toBeUndefined();
  });

  it('identifies a Folder Compare by its sources, not by where the user is in it', () => {
    expect(tabIdentity(`${FOLDERS}&path=docs&commit=abc`, BASE)).toBe(tabIdentity(FOLDERS, BASE));
    expect(tabIdentity(FOLDERS.replace('dev', 'next'), BASE)).not.toBe(tabIdentity(FOLDERS, BASE));
    expect(tabIdentity(`${BASE}/folders`, BASE)).toBe('folders:new');
  });

  it('identifies a File Compare by its pinned commits and paths, not only the file name', () => {
    expect(tabIdentity(`${FILE('a.ts')}&hunk=2&explain=1`, BASE)).toBe(
      tabIdentity(FILE('a.ts'), BASE),
    );
    expect(tabIdentity(FILE('a.ts'), BASE)).not.toBe(tabIdentity(FILE('b.ts'), BASE));
    // Same file name, different snapshot pair: a genuinely different context.
    expect(tabIdentity(FILE('a.ts', ['c', 'd']), BASE)).not.toBe(tabIdentity(FILE('a.ts'), BASE));
  });

  it('tells what kind of workspace a URL is', () => {
    expect(tabKind(BASE, BASE)).toBe('home');
    expect(tabKind(FOLDERS, BASE)).toBe('folders');
    expect(tabKind(FILE('a.ts'), BASE)).toBe('file');
    expect(tabKind(`${BASE}/upstream`, BASE)).toBe('upstream');
    expect(tabKind(`${BASE}/commit?repo=r1&commit=abc`, BASE)).toBe('commit');
    expect(tabKind(`${BASE}/commits?side=left`, BASE)).toBe('commits');
  });

  it('identifies a commit by its repo and SHA, so opening it twice reuses one tab', () => {
    const commit = (sha: string, repo = 'r1') => `${BASE}/commit?repo=${repo}&commit=${sha}`;
    expect(tabIdentity(`${commit('abc')}&ignored=1`, BASE)).toBe(tabIdentity(commit('abc'), BASE));
    expect(tabIdentity(commit('abc'), BASE)).not.toBe(tabIdentity(commit('def'), BASE));
    expect(tabIdentity(commit('abc'), BASE)).not.toBe(tabIdentity(commit('abc', 'r2'), BASE));
  });

  it('identifies a commit list by its side and the pinned snapshots and file', () => {
    const list = (side: string, commits = ['a', 'b'], path = 'a.ts') =>
      `${BASE}/commits?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev&leftCommit=${commits[0] ?? ''}&rightCommit=${commits[1] ?? ''}&leftPath=${path}&rightPath=${path}&side=${side}`;
    // Where the user is inside the list (focused hunk) does not make another tab.
    expect(tabIdentity(`${list('left')}&hunk=1`, BASE)).toBe(tabIdentity(list('left'), BASE));
    // Left and Right commit lists are separate tabs.
    expect(tabIdentity(list('left'), BASE)).not.toBe(tabIdentity(list('right'), BASE));
    expect(tabIdentity(list('left', ['c', 'd']), BASE)).not.toBe(tabIdentity(list('left'), BASE));
  });
});

describe('syncTabs', () => {
  const home: WorkspaceTab = { id: 'home', url: BASE };
  const folders: WorkspaceTab = { id: 'f1', url: FOLDERS };

  it('always starts with the overview', () => {
    expect(syncTabs([], folders, BASE)).toEqual([home, folders]);
  });

  it('adds a new context after the others and keeps the rest', () => {
    const file = { id: 'x', url: FILE('a.ts') };
    expect(syncTabs([home, folders], file, BASE)).toEqual([home, folders, file]);
  });

  it('follows the user inside an open tab instead of adding another', () => {
    const moved = { ...folders, url: `${FOLDERS}&path=docs` };
    expect(syncTabs([home, folders], moved, BASE)).toEqual([home, moved]);
  });

  it('can put a new context in the place of the one it replaces', () => {
    const other = { id: 'f2', url: FOLDERS.replace('dev', 'next') };
    const file = { id: 'x', url: FILE('a.ts') };
    expect(syncTabs([home, folders, file], other, BASE, { id: 'f1', isTakingPlace: true })).toEqual(
      [home, other, file],
    );
  });

  it('drops a closed tab', () => {
    const file = { id: 'x', url: FILE('a.ts') };
    expect(
      syncTabs([home, folders, file], folders, BASE, { id: 'x', isTakingPlace: false }),
    ).toEqual([home, folders]);
  });
});

describe('tab storage', () => {
  it('round-trips per session and ignores anything malformed', () => {
    const tabs = [
      { id: 'home', url: BASE },
      { id: 'f1', url: FOLDERS },
    ];
    saveTabs('kim', 's1', tabs);
    expect(loadTabs('kim', 's1')).toEqual(tabs);
    expect(loadTabs('kim', 's2')).toEqual([]);
    sessionStorage.setItem('om-tabs:kim:s3', '{"not":"tabs"}');
    expect(loadTabs('kim', 's3')).toEqual([]);
  });
});

describe('range log tabs', () => {
  const logUrl = `${BASE}/log?repo=r1&top=aaa&bottom=bbb`;

  it('recognises a range log and keeps one tab per top and bottom', () => {
    expect(tabKind(logUrl, BASE)).toBe('log');
    expect(tabIdentity(logUrl, BASE)).toBe(
      tabIdentity(`${BASE}/log?repo=r1&top=aaa&bottom=bbb&skip=50`, BASE),
    );
    expect(tabIdentity(logUrl, BASE)).not.toBe(
      tabIdentity(`${BASE}/log?repo=r1&top=aaa&bottom=ccc`, BASE),
    );
  });
});
