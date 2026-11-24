import { describe, expect, it } from 'vitest';
import { AddRepoRequestSchema, CreateSessionRequestSchema, UsernameSchema } from './schemas.ts';

describe('UsernameSchema', () => {
  it('lowercases and trims', () => {
    expect(UsernameSchema.parse('  Karthik ')).toBe('karthik');
  });

  it('allows letters, digits, dot, dash and underscore', () => {
    expect(UsernameSchema.safeParse('k.m_3-x').success).toBe(true);
  });

  it('rejects empty, too long and unsafe names', () => {
    for (const bad of ['', 'a'.repeat(33), '../etc', 'a b', '.hidden', 'x/y']) {
      expect(UsernameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('CreateSessionRequestSchema', () => {
  it('trims the name and allows spaces', () => {
    expect(CreateSessionRequestSchema.parse({ name: '  Release review ' })).toEqual({
      name: 'Release review',
    });
  });

  it('rejects empty and overly long names', () => {
    expect(CreateSessionRequestSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(CreateSessionRequestSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
  });
});

describe('AddRepoRequestSchema', () => {
  it('requires a URL', () => {
    expect(AddRepoRequestSchema.safeParse({ url: ' ' }).success).toBe(false);
    expect(AddRepoRequestSchema.parse({ url: ' https://github.com/a/b.git ' })).toEqual({
      url: 'https://github.com/a/b.git',
    });
  });
});
