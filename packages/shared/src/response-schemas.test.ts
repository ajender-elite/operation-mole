import { describe, expect, it } from 'vitest';
import type { CompareNode, DirectoryCompareResult, SessionDetail } from './api.ts';
import {
  DirectoryCompareResultSchema,
  FileCompareResultSchema,
  SessionDetailSchema,
  SessionSummaryListSchema,
} from './response-schemas.ts';

const file = { kind: 'file', size: 3, mtimeMs: 1 } as const;

const tree: CompareNode = {
  name: '',
  path: '',
  status: 'modified',
  children: [
    {
      name: 'src',
      path: 'src',
      status: 'modified',
      left: { kind: 'directory', size: 0, mtimeMs: 1 },
      right: { kind: 'directory', size: 0, mtimeMs: 1 },
      children: [{ name: 'a.ts', path: 'src/a.ts', status: 'only-left', left: file }],
    },
    {
      name: 'link',
      path: 'link',
      status: 'identical',
      left: { kind: 'symlink', size: 3, mtimeMs: 1, linkTarget: 'src' },
      right: { kind: 'symlink', size: 3, mtimeMs: 1, linkTarget: 'src' },
    },
    { name: 'bad', path: 'bad', status: 'error', error: 'EACCES' },
  ],
};

const comparison: DirectoryCompareResult = {
  left: '/l',
  right: 'C:\\r',
  leftLabel: '/l',
  rightLabel: 'repo @ main',
  root: tree,
  summary: { identical: 1, modified: 0, onlyLeft: 1, onlyRight: 0, errors: 1 },
};

const session = { id: 's1', name: 'One', createdAt: 't', updatedAt: 't', repoCount: 1 };

describe('response schemas', () => {
  it('accept a nested directory comparison unchanged', () => {
    expect(DirectoryCompareResultSchema.parse(comparison)).toEqual(comparison);
  });

  it('reject an unknown status deep in the tree', () => {
    const broken = structuredClone(comparison);
    const child = broken.root.children?.[0]?.children?.[0];
    if (child === undefined) throw new Error('fixture changed');
    Object.assign(child, { status: 'renamed' });
    expect(DirectoryCompareResultSchema.safeParse(broken).success).toBe(false);
  });

  it('accept a session detail with git and path sources', () => {
    const detail: SessionDetail = {
      user: 'ana',
      session,
      repos: [
        {
          id: 'r1',
          url: 'https://example.com/a.git',
          name: 'a',
          defaultBranch: 'main',
          branches: ['main'],
          fetchedAt: 't',
        },
      ],
      recent: [
        {
          id: 'c1',
          left: { type: 'git', repoId: 'r1', branch: 'main' },
          right: { type: 'path', path: '/x' },
          leftLabel: 'a @ main',
          rightLabel: '/x',
          comparedAt: 't',
        },
      ],
    };
    expect(SessionDetailSchema.parse(detail)).toEqual(detail);
  });

  it('accept file results with one side missing and binary or large files', () => {
    const result = {
      identical: false,
      left: { path: '/a.png', size: 9, sha256: 'x', binary: true },
      right: { path: '/b.txt', size: 9, sha256: 'y', binary: false, tooLarge: true },
    };
    expect(FileCompareResultSchema.parse(result)).toEqual(result);
    expect(FileCompareResultSchema.parse({ identical: false })).toEqual({ identical: false });
  });

  it('reject a response of the wrong shape', () => {
    expect(SessionSummaryListSchema.safeParse([{ ...session, repoCount: '1' }]).success).toBe(
      false,
    );
  });
});
