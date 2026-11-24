import type { GitBlame, GitFile } from '@om/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoInfo, sessionDetailHandler } from '../test/handlers.ts';
import {
  blameHandler,
  commitInfo,
  fileHandler,
  filesHandler,
  node,
  refEntry,
  refsHandler,
  showHandler,
  textFile,
  treeHandler,
} from '../test/explore-handlers.ts';
import { renderApp } from '../test/render.tsx';
import { server } from '../test/server.ts';

const BASE = '/u/karthik/s/s1';
const SHA_ONE = '1'.repeat(40);
const SHA_TWO = '2'.repeat(40);

let asked: string[];

beforeEach(() => {
  asked = [];
  server.use(sessionDetailHandler({ repos: [repoInfo()] }));
});

describe('Code tab: a folder', () => {
  it('lists the folders first, then the files, each a link into the tree', async () => {
    server.use(
      treeHandler({
        // The server sends folders first; the page keeps that order.
        '': [node('src', 'directory'), node('README.md')],
      }),
    );
    renderApp(`${BASE}/code?repo=r1&ref=main`);
    const list = await screen.findByRole('list', { name: 'Files and folders' });
    const names = within(list)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(names).toEqual(['src', 'README.md']);
  });

  it('opens the commits touching a folder in their own History tab', async () => {
    server.use(
      treeHandler({
        '': [node('src', 'directory')],
        src: [node('a.c', 'file', 'src')],
      }),
    );
    const { router } = renderApp(`${BASE}/code?repo=r1&ref=main&path=src`);
    await userEvent.click(
      await screen.findByRole('button', { name: /Commits touching this folder/ }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/commits`);
    });
    expect(new URLSearchParams(router.state.location.search).get('path')).toBe('src');
    expect(new URLSearchParams(router.state.location.search).get('ref')).toBe('main');
  });
});

describe('Code tab: a file', () => {
  beforeEach(() => {
    server.use(
      treeHandler({ src: [node('a.c', 'file', 'src')] }),
      fileHandler({ 'src/a.c': textFile('src/a.c', 'one\ntwo\n') }),
    );
  });

  it('shows each line, with the last change to it: one tag per run of lines', async () => {
    server.use(
      blameHandler(
        {
          'src/a.c': {
            path: 'src/a.c',
            commit: SHA_TWO,
            lines: [
              { line: 1, commit: SHA_ONE, origLine: 1, boundary: true },
              { line: 2, commit: SHA_ONE, origLine: 2, boundary: true },
            ],
            commits: [commitInfo(SHA_ONE, 'Add a', 'Ada')],
          } satisfies GitBlame,
        },
        asked,
      ),
    );
    renderApp(`${BASE}/code?repo=r1&ref=main&path=src/a.c`);
    const table = await screen.findByRole('table', { name: 'src/a.c at main' });
    expect(within(table).getByText('one')).toBeInTheDocument();
    expect(within(table).getByText('two')).toBeInTheDocument();
    // Both lines came from one commit: its short SHA is shown once, on the first line of the run.
    await waitFor(() => {
      expect(within(table).getAllByText(SHA_ONE.slice(0, 8))).toHaveLength(1);
    });
    expect(asked).toEqual(['src/a.c']);
  });

  it('hides blame when asked, and does not fetch it', async () => {
    renderApp(`${BASE}/code?repo=r1&ref=main&path=src/a.c&blame=0`);
    const table = await screen.findByRole('table', { name: 'src/a.c at main' });
    expect(within(table).getByText('one')).toBeInTheDocument();
    expect(within(table).queryByText(SHA_ONE.slice(0, 8))).toBeNull();
    expect(asked).toEqual([]);
    expect(screen.getByRole('link', { name: /Blame off/ })).toBeInTheDocument();
  });

  it('colours the code by its language, with the palette variables', async () => {
    server.use(fileHandler({ 'src/a.c': textFile('src/a.c', 'int one = 1;\n') }));
    renderApp(`${BASE}/code?repo=r1&ref=main&path=src/a.c&blame=0`);
    const table = await screen.findByRole('table', { name: 'src/a.c at main' });
    // The C grammar colours a keyword; the colour is a palette variable, so both themes apply.
    await waitFor(() => {
      const keyword = within(table).getByText('int');
      expect(keyword.getAttribute('style') ?? '').toContain('--color-syntax-');
    });
  }, 20_000);

  it('highlights the lines named in the URL', async () => {
    renderApp(`${BASE}/code?repo=r1&ref=main&path=src/a.c&blame=0&lines=2`);
    const table = await screen.findByRole('table', { name: 'src/a.c at main' });
    const highlighted = table.querySelector('tr[data-line="2"]');
    expect(highlighted?.className).toContain('bg-accent-soft');
    expect(table.querySelector('tr[data-line="1"]')?.className ?? '').not.toContain(
      'bg-accent-soft',
    );
  });

  it('says a binary file is not shown', async () => {
    const binary: GitFile = {
      commit: SHA_TWO,
      path: 'src/bin.dat',
      oid: 'f'.repeat(40),
      size: 12,
      content: 'binary',
    };
    server.use(
      treeHandler({ src: [node('bin.dat', 'file', 'src')] }),
      fileHandler({ 'src/bin.dat': binary }),
    );
    renderApp(`${BASE}/code?repo=r1&ref=main&path=src/bin.dat`);
    expect(await screen.findByText(/Binary file/)).toBeInTheDocument();
  });

  it('says a file that is not in the ref is not there', async () => {
    renderApp(`${BASE}/code?repo=r1&ref=main&path=src/missing.c`);
    expect(await screen.findByText('src/missing.c is not in main.')).toBeInTheDocument();
  });
});

describe('Code tab: go to file', () => {
  beforeEach(() => {
    server.use(
      treeHandler({ '': [node('src', 'directory'), node('README.md')] }),
      filesHandler(['README.md', 'src/main.c', 'src/http/main_core.c']),
    );
  });

  it('opens with t, finds a file by part of its name, and opens it on Enter', async () => {
    const { router } = renderApp(`${BASE}/code?repo=r1&ref=main`);
    await screen.findByRole('list', { name: 'Files and folders' });
    await userEvent.keyboard('t');
    const finder = await screen.findByRole('dialog', { name: 'Go to file' });
    await userEvent.type(within(finder).getByRole('combobox'), 'main');
    const options = within(finder).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['src/main.c', 'src/http/main_core.c']);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('path')).toBe('src/main.c');
    });
  });

  it('closes on Escape, and a t typed in the finder is a letter', async () => {
    renderApp(`${BASE}/code?repo=r1&ref=main`);
    await screen.findByRole('list', { name: 'Files and folders' });
    await userEvent.keyboard('t');
    const input = await screen.findByRole('combobox', { name: 'Find a file' });
    await userEvent.type(input, 't');
    expect(input).toHaveValue('t');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Go to file' })).toBeNull();
  });

  it('opens Search with /', async () => {
    const { router } = renderApp(`${BASE}/code?repo=r1&ref=main`);
    await screen.findByRole('list', { name: 'Files and folders' });
    await userEvent.keyboard('/');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/search`);
    });
  });
});

describe('Code tab: links', () => {
  it('explains an incomplete link instead of showing an empty page', async () => {
    renderApp(`${BASE}/code`);
    expect(await screen.findByText(/This code link is incomplete/)).toBeInTheDocument();
  });

  it('says so when the repo is no longer in the session', async () => {
    server.use(sessionDetailHandler({ repos: [] }));
    renderApp(`${BASE}/code?repo=r1&ref=main`);
    expect(
      await screen.findByText('This repository is no longer in the session.'),
    ).toBeInTheDocument();
  });
});

describe('Code tab: a file with no grammar', () => {
  it('shows its lines as plain text, without a highlighting failure', async () => {
    server.use(
      treeHandler({ '': [node('notes.xyz')] }),
      fileHandler({ 'notes.xyz': textFile('notes.xyz', 'plain words\n') }),
    );
    renderApp(`${BASE}/code?repo=r1&ref=main&path=notes.xyz&blame=0`);
    const table = await screen.findByRole('table', { name: 'notes.xyz at main' });
    expect(within(table).getByText('plain words')).toBeInTheDocument();
  });
});

describe('Code tab: tree, README, permalink and blame actions', () => {
  const SHA_X = 'f'.repeat(40);
  const SHA_Y = '9'.repeat(40);

  beforeEach(() => {
    server.use(
      treeHandler({
        '': [node('src', 'directory'), node('README.md')],
        src: [node('a.c', 'file', 'src')],
      }),
      fileHandler({ 'README.md': textFile('README.md', 'Hello from the readme\n') }),
    );
  });

  it('shows the README of a folder under its listing', async () => {
    renderApp(`${BASE}/code?repo=r1&ref=main`);
    expect(await screen.findByText('Hello from the readme')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'README.md' })).toBeInTheDocument();
  });

  it('opens a folder in the tree beside the file, and lists its files', async () => {
    renderApp(`${BASE}/code?repo=r1&ref=main`);
    const tree = await screen.findByRole('navigation', { name: 'Files in this ref' });
    await userEvent.click(within(tree).getByRole('button', { name: 'Open src' }));
    expect(await within(tree).findByRole('link', { name: 'a.c' })).toBeInTheDocument();
  });

  it('copies a permalink pinned to the commit the file was read at', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    server.use(fileHandler({ 'README.md': { ...textFile('README.md', 'x\n'), commit: SHA_X } }));
    renderApp(`${BASE}/code?repo=r1&ref=main&path=README.md&blame=0`);
    await userEvent.click(await screen.findByRole('button', { name: /Copy permalink/ }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`ref=${SHA_X}`));
    });
    expect(writeText.mock.calls[0]?.[0]).toContain('path=README.md');
  });

  it('opens the last change of a line in a panel, with the file at that commit one click away', async () => {
    server.use(
      blameHandler({
        'README.md': {
          path: 'README.md',
          commit: SHA_Y,
          lines: [{ line: 1, commit: SHA_Y, origLine: 1, boundary: false }],
          commits: [commitInfo(SHA_Y, 'Tidy the readme', 'Ada')],
        } satisfies GitBlame,
      }),
    );
    const { router } = renderApp(`${BASE}/code?repo=r1&ref=main&path=README.md`);
    await userEvent.click(
      await screen.findByRole('button', { name: `Last change ${SHA_Y.slice(0, 8)} by Ada` }),
    );
    const panel = await screen.findByRole('dialog', { name: `Commit ${SHA_Y.slice(0, 8)}` });
    expect(within(panel).getByText('Tidy the readme')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'View file at this commit' }));
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('ref')).toBe(SHA_Y);
    });
    expect(router.state.location.pathname).toBe(`${BASE}/code`);
  });

  it('opens the file before a change at the commit parent, under the path it had then', async () => {
    const PARENT = '3'.repeat(40);
    server.use(
      showHandler({ [SHA_Y]: [PARENT] }),
      blameHandler({
        'README.md': {
          path: 'README.md',
          commit: SHA_Y,
          lines: [{ line: 1, commit: SHA_Y, origLine: 1, origPath: 'OLD.md', boundary: false }],
          commits: [commitInfo(SHA_Y, 'Rename and edit', 'Ada')],
        } satisfies GitBlame,
      }),
    );
    const { router } = renderApp(`${BASE}/code?repo=r1&ref=main&path=README.md`);
    await userEvent.click(
      await screen.findByRole('button', { name: `Last change ${SHA_Y.slice(0, 8)} by Ada` }),
    );
    const panel = await screen.findByRole('dialog', { name: `Commit ${SHA_Y.slice(0, 8)}` });
    await userEvent.click(
      await within(panel).findByRole('button', { name: 'Blame before this change' }),
    );
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('ref')).toBe(PARENT);
    });
    expect(new URLSearchParams(router.state.location.search).get('path')).toBe('OLD.md');
  });

  it('offers no blame before a change that is the first commit of the file', async () => {
    server.use(
      showHandler({ [SHA_Y]: [] }),
      blameHandler({
        'README.md': {
          path: 'README.md',
          commit: SHA_Y,
          lines: [{ line: 1, commit: SHA_Y, origLine: 1, boundary: true }],
          commits: [commitInfo(SHA_Y, 'Add the readme', 'Ada')],
        } satisfies GitBlame,
      }),
    );
    renderApp(`${BASE}/code?repo=r1&ref=main&path=README.md`);
    await userEvent.click(
      await screen.findByRole('button', { name: `Last change ${SHA_Y.slice(0, 8)} by Ada` }),
    );
    const panel = await screen.findByRole('dialog', { name: `Commit ${SHA_Y.slice(0, 8)}` });
    expect(
      await within(panel).findByText('No earlier version: this is the first commit of the file.'),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Blame before this change' })).toBeNull();
  });
});

describe('Code tab: choosing another branch or tag', () => {
  it('opens the same folder at the branch chosen, in a tab of its own', async () => {
    server.use(
      treeHandler({ '': [node('README.md', 'file')] }),
      refsHandler([refEntry('origin', 'main'), refEntry('origin', 'dev')]),
    );
    const { router } = renderApp(`${BASE}/code?repo=r1&ref=main`);
    await screen.findByRole('option', { name: 'dev' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Branch or tag' }), 'dev');
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('ref')).toBe('dev');
    });
    expect(router.state.location.pathname).toBe(`${BASE}/code`);
  });
});

describe('Code tab: copying the path of a file', () => {
  it('copies the file path as written in the ref', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    server.use(
      treeHandler({ '': [node('src', 'directory')], src: [node('a.c', 'file', 'src')] }),
      fileHandler({ 'src/a.c': textFile('src/a.c', 'int x;\n') }),
    );
    renderApp(`${BASE}/code?repo=r1&ref=main&path=src/a.c&blame=0`);
    await userEvent.click(await screen.findByRole('button', { name: /Copy path/ }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('src/a.c');
    });
  });
});

describe('Code tab: comparing a folder', () => {
  it('opens Folder Compare on this folder, with this ref on both sides to change the other', async () => {
    server.use(treeHandler({ '': [node('src', 'directory')], src: [node('a.c', 'file', 'src')] }));
    const { router } = renderApp(`${BASE}/code?repo=r1&ref=main&path=src`);
    await userEvent.click(await screen.findByRole('button', { name: /Compare this folder/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`${BASE}/folders`);
    });
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get('leftRepo')).toBe('r1');
    expect(params.get('leftBranch')).toBe('main');
    expect(params.get('rightBranch')).toBe('main');
    expect(params.get('path')).toBe('src');
  });
});
