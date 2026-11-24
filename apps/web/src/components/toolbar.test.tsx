import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { stubViewport } from '../test/setup.ts';
import { Toolbar, type ToolbarItem } from './toolbar.tsx';

const items: ToolbarItem[] = [
  { key: 'prev', priority: 'primary', node: <button type="button">Previous</button> },
  { key: 'next', priority: 'primary', node: <button type="button">Next</button> },
  { key: 'whole', priority: 'secondary', node: <button type="button">Whole file</button> },
  { key: 'explain', priority: 'secondary', node: <button type="button">Explain</button> },
];

describe('Toolbar', () => {
  it('shows every action inline on a desktop', () => {
    stubViewport({ width: 1280, height: 800 });
    render(<Toolbar items={items} />);
    expect(screen.getByRole('button', { name: 'Whole file' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Explain' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument();
  });

  it('keeps primary actions inline on a phone and moves the rest into More', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const user = userEvent.setup();
    render(<Toolbar items={items} />);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Whole file' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /more/i }));
    const menu = screen.getByRole('group', { name: /more actions/i });
    expect(within(menu).getByRole('button', { name: 'Whole file' })).toBeVisible();
    expect(within(menu).getByRole('button', { name: 'Explain' })).toBeVisible();
  });

  it('closes More after an action is chosen', async () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    const user = userEvent.setup();
    render(<Toolbar items={items} />);
    await user.click(screen.getByRole('button', { name: /more/i }));
    await user.click(screen.getByRole('button', { name: 'Explain' }));
    expect(screen.queryByRole('group', { name: /more actions/i })).not.toBeInTheDocument();
  });

  it('collapses on a phone in landscape too', () => {
    stubViewport({ width: 844, height: 390, pointer: 'coarse' });
    render(<Toolbar items={items} />);
    expect(screen.queryByRole('button', { name: 'Whole file' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more/i })).toHaveAttribute('aria-expanded', 'false');
  });
});
