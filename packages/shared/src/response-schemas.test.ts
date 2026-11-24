import { describe, expect, it } from 'vitest';
import type { CompareNode, FolderComparison, SessionDetail } from './api.ts';
import {
  FolderComparisonSchema,
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

const comparison: FolderComparison = {
  leftLabel: 'repo @ main',
  rightLabel: 'repo @ dev',
  root: tree,
  summary: { identical: 1, modified: 0, onlyLeft: 1, onlyRight: 0, errors: 1 },
  leftSnapshot: { commit: 'a'.repeat(40), ref: 'main' },
};

const session = { id: 's1', name: 'One', createdAt: 't', updatedAt: 't', repoCount: 1 };

describe('response schemas', () => {
  it('accept a nested folder comparison unchanged', () => {
    expect(FolderComparisonSchema.parse(comparison)).toEqual(comparison);
  });

  it('reject an unknown status deep in the tree', () => {
    const broken = structuredClone(comparison);
    const child = broken.root.children?.[0]?.children?.[0];
    if (child === undefined) throw new Error('fixture changed');
    Object.assign(child, { status: 'renamed' });
    expect(FolderComparisonSchema.safeParse(broken).success).toBe(false);
  });

  it('accept a session detail with its repos and their remotes', () => {
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
          remotes: [
            {
              name: 'origin',
              url: 'https://example.com/a.git',
              defaultBranch: 'main',
              branches: ['main'],
              fetchedAt: 't',
            },
          ],
        },
      ],
    };
    expect(SessionDetailSchema.parse(detail)).toEqual(detail);
  });

  it('reject a response of the wrong shape', () => {
    expect(SessionSummaryListSchema.safeParse([{ ...session, repoCount: '1' }]).success).toBe(
      false,
    );
  });
});
