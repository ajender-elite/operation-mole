import type { GitSource, RepoInfo } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { dirResult } from '../test/fixtures.ts';
import { USER, repoInfo } from '../test/handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

type CompareBody = {
  left: GitSource;
  right: GitSource;
  user?: string;
  sessionId?: string;
};

let requests: CompareBody[];
let repos: RepoInfo[];
let fetchCalls: string[];

const label = (s: GitSource) => `app @ ${s.branch}`;
const root = (s: GitSource) => `/data/wt/${s.repoId}/${s.branch}`;

beforeEach(() => {
  requests = [];
  fetchCalls = [];
  repos = [repoInfo()];
  server.use(
    http.get('*/api/users/:user/sessions/:sessionId', ({ params }) =>
      HttpResponse.json({
        user: params['user'],
        session: {
          id: params['sessionId'],
          name: 'Release review',
          createdAt: '',
          updatedAt: '',
          repoCount: repos.length,
        },
        repos,
        recent: [],
      }),
    ),
    http.post('*/api/users/:user/sessions/:sessionId/repos', async ({ request }) => {
      const { url } = (await request.json()) as { url: string };
      if (url.includes('broken')) {
        return HttpResponse.json(
          { message: `Could not clone ${url}: repository not found` },
          { status: 400 },
        );
      }
      const repo = repoInfo({ id: 'r2', url, name: 'lib', branches: ['main', 'next'] });
      repos = [...repos, repo];
      return HttpResponse.json(repo, { status: 201 });
    }),
    http.post('*/api/users/:user/sessions/:sessionId/repos/:repoId/fetch', ({ params }) => {
      fetchCalls.push(String(params['repoId']));
      repos = repos.map((r) =>
        r.id === params['repoId'] ? { ...r, branches: [...r.branches, 'hotfix'] } : r,
      );
      return HttpResponse.json(repos.find((r) => r.id === params['repoId']));
    }),
    http.post('*/api/compare/directories', async ({ request }) => {
      const body = (await request.json()) as CompareBody;
      requests.push(body);
      if (body.left.branch === 'missing') {
        return HttpResponse.json({ message: 'Branch not found: missing' }, { status: 400 });
      }
      return HttpResponse.json({
        ...dirResult,
        left: root(body.left),
        right: root(body.right),
        leftLabel: label(body.left),
        rightLabel: label(body.right),
        leftSnapshot: { commit: 'a'.repeat(40), ref: body.left.branch },
        rightSnapshot: { commit: 'b'.repeat(40), ref: body.right.branch },
      });
    }),
  );
});

const BASE = `/u/${USER}/s/s1`;
const FOLDERS = `${BASE}/folders`;
const FILE = `${BASE}/file`;
const row = (name: string) => screen.findByRole('treeitem', { name });
const loaded = `${FOLDERS}?leftRepo=r1&leftBranch=main&rightRepo=r1&rightBranch=dev`;

describe('DirectoryComparePage', () => {
  it('asks for a repository and branch on both sides when nothing is chosen', async () => {
    renderApp(FOLDERS);
    expect(
      await screen.findByText(/choose a repository and a branch for both sides/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Base repository URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Target repository URL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^compare$/i })).toBeDisabled();
  });

  it('does not preselect a branch: the user must choose one', async () => {
    const user = userEvent.setup();
    renderApp(FOLDERS);
    await user.selectOptions(await screen.findByLabelText('Base repository'), 'r1');
    expect(screen.getByLabelText('Base branch')).toHaveValue('');
    expect(screen.getByRole('button', { name: /^compare$/i })).toBeDisabled();
  });

  it('puts the repos and branches in the URL and shows the colored comparison', async () => {
    const user = userEvent.setup();
    const app = renderApp(FOLDERS);
    const sides = { Base: 'main', Target: 'dev' } as const;
    for (const [side, branch] of Object.entries(sides)) {
      await user.selectOptions(await screen.findByLabelText(`${side} repository`), 'r1');
      await user.selectOptions(screen.getByLabelText(`${side} branch`), branch);
    }
    await user.click(screen.getByRole('button', { name: /^compare$/i }));

    expect(await row('docs')).toHaveAttribute('data-status', 'modified');
    expect(app.search().get('leftRepo')).toBe('r1');
    expect(app.search().get('leftBranch')).toBe('main');
    expect(app.search().get('rightBranch')).toBe('dev');
    expect(requests).toEqual([
      {
        left: { type: 'git', repoId: 'r1', branch: 'main' },
        right: { type: 'git', repoId: 'r1', branch: 'dev' },
        user: USER,
        sessionId: 's1',
      },
    ]);

    expect(await row('new.txt')).toHaveAttribute('data-status', 'only-right');
    expect(await row('same.txt')).toHaveAttribute('data-status', 'identical');

    const summary = screen.getByRole('group', { name: /summary/i });
    expect(within(summary).getByRole('button', { name: /identical.*3/i })).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: /only in base.*2/i })).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: /only in target.*2/i })).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: /different.*1/i })).toBeInTheDocument();
  });

  it('keeps the sources out of the way once compared, editable on request', async () => {
    const user = userEvent.setup();
    renderApp(loaded);
    expect(await row('docs')).toBeInTheDocument();
    expect(screen.queryByLabelText('Base repository')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByLabelText('Base repository')).toHaveValue('r1');
    expect(screen.getByLabelText('Base branch')).toHaveValue('main');
    expect(screen.getByLabelText('Target branch')).toHaveValue('dev');
  });

  it('shows the entry only on its own side for one-sided entries', async () => {
    renderApp(loaded);
    const newTxt = await row('new.txt');
    expect(within(newTxt).getByTestId('cell-left')).toHaveAttribute('data-present', 'false');
    expect(within(newTxt).getByTestId('cell-right')).toHaveAttribute('data-present', 'true');
  });

  it('shows a file and a folder with the same name as separate one-sided rows', async () => {
    const user = userEvent.setup();
    const app = renderApp(loaded);
    const outputs = await screen.findAllByRole('treeitem', { name: 'output' });
    const [outputDir, outputFile] = outputs;
    if (!outputDir || !outputFile) throw new Error('expected two output rows');
    expect(outputs.map((r) => r.getAttribute('data-status'))).toEqual(['only-right', 'only-left']);
    expect(within(outputFile).getByTestId('cell-left')).toHaveAttribute('data-present', 'true');
    expect(within(outputFile).getByTestId('cell-right')).toHaveAttribute('data-present', 'false');

    await user.dblClick(outputDir);
    expect(await row('report.txt')).toBeInTheDocument();
    expect(app.search().get('path')).toBe('output');
  });

  it('opens the left-only file of a file/folder name clash on its own', async () => {
    const user = userEvent.setup();
    const app = renderApp(loaded);
    const [, outputFile] = await screen.findAllByRole('treeitem', { name: 'output' });
    if (!outputFile) throw new Error('expected two output rows');
    await user.dblClick(outputFile);
    await waitFor(() => {
      expect(app.location().pathname).toBe(FILE);
    });
    expect(app.search().get('leftPath')).toBe('output');
    expect(app.search().has('rightPath')).toBe(false);
  });

  it('restores the current folder from the URL (e.g. after reload)', async () => {
    renderApp(`${loaded}&path=docs`);
    expect(await row('readme.md')).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'same.txt' })).not.toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(crumbs).getByText('docs')).toHaveAttribute('aria-current', 'page');
  });

  it('navigates into a folder on double-click and records it in the URL', async () => {
    const user = userEvent.setup();
    const app = renderApp(loaded);
    await user.dblClick(await row('docs'));
    expect(await row('readme.md')).toBeInTheDocument();
    expect(app.search().get('path')).toBe('docs');
    expect(app.search().get('leftRepo')).toBe('r1');
  });

  it('navigates into a folder with Enter', async () => {
    const user = userEvent.setup();
    const app = renderApp(loaded);
    (await row('src')).focus();
    await user.keyboard('{Enter}');
    expect(await row('index.ts')).toBeInTheDocument();
    expect(app.search().get('path')).toBe('src');
  });

  it('navigates up via breadcrumbs', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${loaded}&path=docs%2Fold`);
    expect(await row('a.txt')).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    await user.click(within(crumbs).getByRole('link', { name: 'docs' }));
    expect(await row('readme.md')).toBeInTheDocument();
    expect(app.search().get('path')).toBe('docs');
    await user.click(within(crumbs).getByRole('link', { name: /root/i }));
    expect(await row('same.txt')).toBeInTheDocument();
    expect(app.search().has('path')).toBe(false);
  });

  it('expands a folder in place with its chevron', async () => {
    const user = userEvent.setup();
    const app = renderApp(loaded);
    const docs = await row('docs');
    expect(docs).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(docs).getByRole('button', { name: /expand/i }));
    expect(docs).toHaveAttribute('aria-expanded', 'true');
    expect(await row('readme.md')).toHaveAttribute('aria-level', '2');
    expect(screen.getByRole('treeitem', { name: 'same.txt' })).toBeInTheDocument();
    expect(app.search().has('path')).toBe(false);
  });

  it('can show differences only', async () => {
    const user = userEvent.setup();
    renderApp(loaded);
    await row('same.txt');
    await user.click(screen.getByRole('radio', { name: /differences only/i }));
    expect(screen.queryByRole('treeitem', { name: 'same.txt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'src' })).not.toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'new.txt' })).toBeInTheDocument();
  });

  it('explains when the folder in the URL no longer exists', async () => {
    renderApp(`${loaded}&path=gone`);
    expect(await screen.findByText(/not found in this comparison/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to root/i })).toBeInTheDocument();
  });

  it('shows API errors', async () => {
    renderApp(`${FOLDERS}?leftRepo=r1&leftBranch=missing&rightRepo=r1&rightBranch=dev`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Branch not found: missing');
  });

  it('opens a file in its own File Compare tab, pinned to the compared commits', async () => {
    const user = userEvent.setup();
    const app = renderApp(`${loaded}&path=docs`);
    await user.dblClick(await row('readme.md'));
    await waitFor(() => {
      expect(app.location().pathname).toBe(FILE);
    });
    expect(app.search().get('leftPath')).toBe('docs/readme.md');
    expect(app.search().get('rightPath')).toBe('docs/readme.md');
    expect(app.search().get('leftCommit')).toBe('a'.repeat(40));
    expect(app.search().get('rightCommit')).toBe('b'.repeat(40));
    expect(app.search().get('leftBranch')).toBe('main');
  });

  it('sends old /files links to Folders', async () => {
    const app = renderApp(`${BASE}/files?leftRepo=r1&leftBranch=main`);
    await waitFor(() => {
      expect(app.location().pathname).toBe(FOLDERS);
    });
    expect(app.search().get('leftBranch')).toBe('main');
  });

  it('compares two branches of a repo already in the session', async () => {
    const user = userEvent.setup();
    const app = renderApp(FOLDERS);
    await screen.findByText(/choose a repository and a branch/i);

    for (const side of ['Base', 'Target'] as const) {
      await user.selectOptions(await screen.findByLabelText(`${side} repository`), 'r1');
    }
    await user.selectOptions(screen.getByLabelText('Base branch'), 'main');
    await user.selectOptions(screen.getByLabelText('Target branch'), 'dev');
    await user.click(screen.getByRole('button', { name: /^compare$/i }));

    expect(await row('docs')).toBeInTheDocument();
    expect(app.search().get('leftRepo')).toBe('r1');
    expect(app.search().get('rightBranch')).toBe('dev');
    const columns = screen.getByTestId('column-labels');
    expect(within(columns).getByText('app @ main')).toBeInTheDocument();
    expect(within(columns).getByText('app @ dev')).toBeInTheDocument();
  });

  it('clones a new repo by URL from the repository list, then needs an explicit branch', async () => {
    const user = userEvent.setup();
    renderApp(FOLDERS);
    await user.selectOptions(await screen.findByLabelText('Target repository'), 'add');
    await user.type(
      screen.getByLabelText('Target repository URL'),
      'https://github.com/acme/lib.git',
    );
    await user.click(screen.getByRole('button', { name: 'Clone target repository' }));

    expect(await screen.findByLabelText('Target repository')).toHaveValue('r2');
    expect(screen.getByLabelText('Target branch')).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Target branch'), 'next');
    expect(screen.getByLabelText('Target branch')).toHaveValue('next');
  });

  it('explains when a repo cannot be cloned', async () => {
    const user = userEvent.setup();
    repos = [];
    renderApp(FOLDERS);
    const base = screen.getByRole('group', { name: 'Base' });
    await user.type(
      within(base).getByLabelText('Base repository URL'),
      'https://github.com/acme/broken.git',
    );
    await user.click(within(base).getByRole('button', { name: 'Clone base repository' }));
    expect(await screen.findByText(/could not clone/i)).toBeInTheDocument();
  });

  it('fetches the latest branches for a repo on request', async () => {
    const user = userEvent.setup();
    renderApp(FOLDERS);
    await user.selectOptions(await screen.findByLabelText('Base repository'), 'r1');
    await user.click(screen.getByRole('button', { name: 'Fetch latest for base repository' }));
    await waitFor(() => {
      expect(fetchCalls).toEqual(['r1']);
    });
    expect(
      await within(screen.getByLabelText('Base branch')).findByRole('option', { name: 'hotfix' }),
    ).toBeInTheDocument();
  });
});
