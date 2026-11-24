import { describe, expect, it } from 'vitest';
import { tabIdentity, tabKind } from './workspace.ts';

const BASE = '/u/karthik/s/s1';

describe('explorer tabs', () => {
  it('recognises the five explorer pages as tabs', () => {
    expect(tabKind(`${BASE}/code?repo=r1&ref=main`, BASE)).toBe('code');
    expect(tabKind(`${BASE}/commits?repo=r1&ref=main`, BASE)).toBe('commits');
    expect(tabKind(`${BASE}/search?repo=r1&ref=main`, BASE)).toBe('search');
    expect(tabKind(`${BASE}/branches?repo=r1`, BASE)).toBe('branches');
    expect(tabKind(`${BASE}/series?repo=r1`, BASE)).toBe('series');
  });

  it('keeps one Code tab per ref, whatever folder the user is in', () => {
    const at = tabIdentity(`${BASE}/code?repo=r1&ref=main`, BASE);
    expect(tabIdentity(`${BASE}/code?repo=r1&ref=main&path=src&lines=4`, BASE)).toBe(at);
    expect(tabIdentity(`${BASE}/code?repo=r1&ref=dev`, BASE)).not.toBe(at);
  });

  it('keeps one Commits tab per path, so each folder you open gets its own', () => {
    const src = tabIdentity(`${BASE}/commits?repo=r1&ref=main&path=src`, BASE);
    expect(src).not.toBe(tabIdentity(`${BASE}/commits?repo=r1&ref=main&path=docs`, BASE));
    expect(src).not.toBe(tabIdentity(`${BASE}/commits?repo=r1&ref=main`, BASE));
  });

  it('keeps one Series tab per repo, the picks being where the user is in it', () => {
    expect(tabIdentity(`${BASE}/series?repo=r1&picks=aa`, BASE)).toBe(
      tabIdentity(`${BASE}/series?repo=r1`, BASE),
    );
  });
});
