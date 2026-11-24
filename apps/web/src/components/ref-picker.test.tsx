import type { GitRefEntry } from '@om/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RefPicker } from './ref-picker.tsx';

const ref = (remote: string, kind: 'branch' | 'tag', name: string): GitRefEntry => ({
  remote,
  kind,
  name,
  commit: 'a'.repeat(40),
  commitDate: '2026-01-02T10:00:00Z',
  subject: 'Subject',
});

const refs: GitRefEntry[] = [
  ref('origin', 'branch', 'main'),
  ref('origin', 'branch', 'stable-1.28'),
  ref('origin', 'tag', 'release-1.0'),
  ref('upstream', 'branch', 'feature'),
];

function setup(props: Partial<Parameters<typeof RefPicker>[0]> = {}) {
  const onOpen = vi.fn();
  render(
    <RefPicker
      remotes={['origin', 'upstream']}
      refs={refs}
      isLoading={false}
      current={{ remote: 'origin', name: 'main' }}
      onOpen={onOpen}
      {...props}
    />,
  );
  return { onOpen };
}

describe('RefPicker', () => {
  it('lists the branches and tags of the current remote, and opens the one chosen', async () => {
    const { onOpen } = setup();
    const select = screen.getByRole('combobox', { name: 'Branch or tag' });
    expect(screen.getByRole('option', { name: 'release-1.0 (tag)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'feature' })).toBeNull();
    await userEvent.selectOptions(select, 'stable-1.28');
    expect(onOpen).toHaveBeenCalledWith({ remote: 'origin', name: 'stable-1.28' });
  });

  it('shows a remote choice only when the repo has more than one remote, and lists that remote', async () => {
    const { onOpen } = setup();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Remote' }), 'upstream');
    expect(screen.getByRole('option', { name: 'feature' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'main' })).toBeNull();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Branch or tag' }),
      'feature',
    );
    expect(onOpen).toHaveBeenCalledWith({ remote: 'upstream', name: 'feature' });
  });

  it('has no remote choice for a repo with one remote', () => {
    setup({ remotes: ['origin'] });
    expect(screen.queryByRole('combobox', { name: 'Remote' })).toBeNull();
  });

  it('opens a commit by its SHA, and keeps a SHA that is not in the list as the current choice', async () => {
    const sha = 'abcdef1234';
    const { onOpen } = setup({ current: { remote: 'origin', name: sha } });
    expect(screen.getByRole('option', { name: sha })).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Commit SHA' });
    const open = screen.getByRole('button', { name: 'Open commit' });
    expect(open).toBeDisabled();
    await userEvent.type(field, 'ZZZ');
    expect(open).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, '1234abcd');
    await userEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith({ remote: 'origin', name: '1234abcd' });
  });

  it('says the refs are loading while they load', () => {
    setup({ isLoading: true, refs: undefined });
    expect(screen.getByRole('option', { name: 'Loading…' })).toBeInTheDocument();
  });
});
