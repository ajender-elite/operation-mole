import { describe, expect, it } from 'vitest';
import { stubMatchMedia } from '../test/setup.ts';
import { getTheme, setTheme } from './theme.ts';

describe('theme', () => {
  it('is dark when nothing is saved, whatever the system preference', () => {
    stubMatchMedia(false);
    expect(getTheme()).toBe('dark');
    stubMatchMedia(true);
    expect(getTheme()).toBe('dark');
  });

  it('applies and saves an explicit choice', () => {
    setTheme('light');
    expect(getTheme()).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(localStorage.getItem('om-theme')).toBe('light');
  });

  it('reads a saved choice, and a saved choice wins over the system preference', () => {
    stubMatchMedia(false);
    localStorage.setItem('om-theme', 'light');
    expect(getTheme()).toBe('light');
    localStorage.setItem('om-theme', 'dark');
    stubMatchMedia(false);
    expect(getTheme()).toBe('dark');
  });

  it('ignores an unknown saved value and stays dark', () => {
    localStorage.setItem('om-theme', 'sepia');
    expect(getTheme()).toBe('dark');
  });
});
