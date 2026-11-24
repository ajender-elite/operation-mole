import type { CompareNode, FolderComparison } from '@om/shared';

const file = (size = 10) => ({ kind: 'file' as const, size, mtimeMs: 0 });
const dir = () => ({ kind: 'directory' as const, size: 0, mtimeMs: 0 });

export const root: CompareNode = {
  name: '',
  path: '',
  status: 'modified',
  left: dir(),
  right: dir(),
  children: [
    {
      name: 'docs',
      path: 'docs',
      status: 'modified',
      left: dir(),
      right: dir(),
      children: [
        {
          name: 'old',
          path: 'docs/old',
          status: 'only-left',
          left: dir(),
          children: [{ name: 'a.txt', path: 'docs/old/a.txt', status: 'only-left', left: file() }],
        },
        {
          name: 'guide.md',
          path: 'docs/guide.md',
          status: 'identical',
          left: file(),
          right: file(),
        },
        {
          name: 'readme.md',
          path: 'docs/readme.md',
          status: 'modified',
          left: file(1200),
          right: file(1300),
        },
      ],
    },
    {
      name: 'src',
      path: 'src',
      status: 'identical',
      left: dir(),
      right: dir(),
      children: [
        {
          name: 'index.ts',
          path: 'src/index.ts',
          status: 'identical',
          left: file(),
          right: file(),
        },
      ],
    },
    {
      name: 'output',
      path: 'output',
      status: 'only-right',
      right: dir(),
      children: [
        { name: 'report.txt', path: 'output/report.txt', status: 'only-right', right: file() },
      ],
    },
    { name: 'new.txt', path: 'new.txt', status: 'only-right', right: file() },
    { name: 'output', path: 'output', status: 'only-left', left: file() },
    { name: 'same.txt', path: 'same.txt', status: 'identical', left: file(), right: file() },
  ],
};

export const dirResult: FolderComparison = {
  leftLabel: 'app @ main',
  rightLabel: 'app @ dev',
  root,
  summary: { identical: 3, modified: 1, onlyLeft: 2, onlyRight: 2, errors: 0 },
};
