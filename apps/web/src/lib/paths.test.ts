import { describe, expect, it } from 'vitest';
import { isWithin } from './paths.ts';

describe('isWithin', () => {
  it('is true for the folder itself and for everything inside it', () => {
    expect(isWithin('src', 'src')).toBe(true);
    expect(isWithin('src', 'src/http/a.c')).toBe(true);
  });

  it('is false for a sibling whose name starts the same way', () => {
    expect(isWithin('src', 'srcs/a.c')).toBe(false);
    expect(isWithin('src/http', 'src/x.c')).toBe(false);
  });

  it('holds everything at the root', () => {
    expect(isWithin('', 'README')).toBe(true);
  });
});
