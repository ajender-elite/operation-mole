import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ContainedIn } from './contained-in.tsx';

const refs = [
  { remote: 'origin', kind: 'branch' as const, name: 'main' },
  { remote: 'upstream', kind: 'branch' as const, name: 'dev' },
  { remote: 'origin', kind: 'tag' as const, name: 'v1.0' },
];

describe('ContainedIn', () => {
  it('lists the branches and tags that have the commit, with their remote, and opens one', async () => {
    const onOpen = vi.fn();
    render(<ContainedIn refs={refs} isLoading={false} onOpen={onOpen} />);
    expect(screen.getByText('origin/main')).toBeInTheDocument();
    expect(screen.getByText('upstream/dev')).toBeInTheDocument();
    expect(screen.getByText('v1.0 (tag)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'upstream/dev' }));
    expect(onOpen).toHaveBeenCalledWith({ remote: 'upstream', kind: 'branch', name: 'dev' });
  });

  it('says so when no branch or tag has the commit', () => {
    render(<ContainedIn refs={[]} isLoading={false} onOpen={vi.fn()} />);
    expect(screen.getByText('No branch or tag of any remote has this commit.')).toBeInTheDocument();
  });

  it('says it is looking while the answer is on its way', () => {
    render(<ContainedIn refs={undefined} isLoading onOpen={vi.fn()} />);
    expect(screen.getByText('Looking for the branches and tags that have it…')).toBeInTheDocument();
  });
});

describe('ContainedIn: a failed lookup', () => {
  it('says the lookup failed, rather than that it is still looking', () => {
    render(<ContainedIn refs={undefined} isLoading={false} error="Server down" onOpen={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not look up the branches and tags: Server down',
    );
    expect(screen.queryByText('Looking for the branches and tags that have it…')).toBeNull();
  });
});
