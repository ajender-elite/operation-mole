import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { stubViewport } from '../test/setup.ts';
import { Sheet } from './sheet.tsx';

describe('Sheet', () => {
  it('is a full-screen dialog on a phone and closes on Escape', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const onClose = vi.fn();
    render(
      <Sheet title="Explanation" onClose={onClose}>
        <p>Details</p>
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Explanation' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is a side region on a desktop and ignores Escape', async () => {
    stubViewport({ width: 1280, height: 800 });
    const onClose = vi.fn();
    render(
      <Sheet title="Explanation" onClose={onClose}>
        <p>Details</p>
      </Sheet>,
    );
    expect(screen.getByRole('region', { name: 'Explanation' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hides on a phone while closed, without unmounting its content', () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    render(
      <Sheet title="Commit" onClose={() => undefined} isOpen={false}>
        <p>Still mounted</p>
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Commit' })).toHaveClass('max-lg:hidden');
    expect(screen.getByText('Still mounted')).toBeInTheDocument();
  });

  it('offers a Back button on a phone that closes the sheet', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Sheet title="Commit" onClose={onClose} backLabel="Back to commits">
        <p>Details</p>
      </Sheet>,
    );
    await user.click(screen.getByRole('button', { name: 'Back to commits' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
