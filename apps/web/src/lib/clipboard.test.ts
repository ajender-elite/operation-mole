import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.ts';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the async clipboard when the browser has one', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    expect(await copyText('abc1234')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('abc1234');
  });

  it('falls back to a selected textarea when there is no clipboard (plain http to a LAN address)', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    expect(await copyText('abc1234')).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when the async clipboard refuses', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => true });
    expect(await copyText('abc1234')).toBe(true);
  });

  it('reports failure rather than throwing when nothing works', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => {
        throw new Error('no');
      },
    });
    expect(await copyText('abc1234')).toBe(false);
  });
});
