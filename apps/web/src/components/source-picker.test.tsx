import type { RepoInfo } from '@om/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SourceDraft } from '../lib/source-draft.ts';
import { SourcePicker } from './source-picker.tsx';

const fetchedAt = '2026-11-21T10:00:00.000Z';
const repo: RepoInfo = {
  id: 'r1',
  url: 'https://github.com/acme/app.git',
  name: 'app',
  defaultBranch: 'main',
  branches: ['main', 'dev'],
  fetchedAt,
  remotes: [
    {
      name: 'origin',
      url: 'https://github.com/acme/app.git',
      defaultBranch: 'main',
      branches: ['main', 'dev'],
      fetchedAt,
    },
    {
      name: 'upstream',
      url: 'https://github.com/upstream/app.git',
      defaultBranch: 'main',
      branches: ['main', 'release'],
      fetchedAt,
    },
  ],
};

function picker(value: SourceDraft, onChange = vi.fn()) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <SourcePicker
        side="Left"
        value={value}
        onChange={onChange}
        repos={[repo]}
        user="karthik"
        sessionId="s1"
      />
    </QueryClientProvider>,
  );
  return onChange;
}

describe('SourcePicker with a repo on two remotes', () => {
  it('offers a remote, and the branches of the remote the side is on', () => {
    picker({ type: 'git', repoId: 'r1', branch: '', remote: 'upstream' });
    expect(screen.getByLabelText('Left remote')).toHaveValue('upstream');
    const branch = screen.getByLabelText('Left branch');
    expect(within(branch).getByRole('option', { name: 'release' })).toBeInTheDocument();
    expect(within(branch).queryByRole('option', { name: 'dev' })).toBeNull();
  });

  it('starts on origin, and choosing another remote resets the branch', async () => {
    const onChange = picker({ type: 'git', repoId: 'r1', branch: 'dev' });
    expect(screen.getByLabelText('Left remote')).toHaveValue('origin');
    await userEvent.selectOptions(screen.getByLabelText('Left remote'), 'upstream');
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'git',
      repoId: 'r1',
      remote: 'upstream',
      branch: '',
    });
  });

  it('hides the remote choice when the repo has one remote', () => {
    const single: RepoInfo = { ...repo, remotes: [repo.remotes[0] ?? repo.remotes[0]!] };
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <SourcePicker
          side="Left"
          value={{ type: 'git', repoId: 'r1', branch: '' }}
          onChange={vi.fn()}
          repos={[single]}
          user="karthik"
          sessionId="s1"
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByLabelText('Left remote')).toBeNull();
  });
});
