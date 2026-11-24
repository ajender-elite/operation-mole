import { describe, expect, it } from 'vitest';
import { refMatches } from './ref-filter.ts';

describe('refMatches', () => {
  it('matches every name for a blank query', () => {
    expect(refMatches({ name: 'stable-1.28' }, '')).toBe(true);
    expect(refMatches({ name: 'stable-1.28' }, '   ')).toBe(true);
  });

  it('matches a part of the name, ignoring case and surrounding spaces', () => {
    expect(refMatches({ name: 'stable-1.28' }, ' STABLE ')).toBe(true);
    expect(refMatches({ name: 'stable-1.28' }, '1.28')).toBe(true);
    expect(refMatches({ name: 'stable-1.28' }, 'mainline')).toBe(false);
  });
});
