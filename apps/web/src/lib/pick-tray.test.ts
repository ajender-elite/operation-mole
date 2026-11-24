import { beforeEach, describe, expect, it } from 'vitest';
import { loadPicks, savePicks, withPick } from './pick-tray.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

beforeEach(() => {
  sessionStorage.clear();
});

describe('the pick tray', () => {
  it('remembers the picks per session and repo, in order', () => {
    savePicks('karthik', 's1', 'r1', [A, B]);
    expect(loadPicks('karthik', 's1', 'r1')).toEqual([A, B]);
    expect(loadPicks('karthik', 's1', 'r2')).toEqual([]);
    expect(loadPicks('karthik', 's2', 'r1')).toEqual([]);
  });

  it('drops anything stored that is not a full commit id', () => {
    sessionStorage.setItem('om-picks:karthik:s1:r1', JSON.stringify([A, 'nope', 7, B]));
    expect(loadPicks('karthik', 's1', 'r1')).toEqual([A, B]);
  });

  it('reads nothing from a value that is not a list', () => {
    sessionStorage.setItem('om-picks:karthik:s1:r1', '{"picks": true}');
    expect(loadPicks('karthik', 's1', 'r1')).toEqual([]);
    sessionStorage.setItem('om-picks:karthik:s1:r1', 'not json');
    expect(loadPicks('karthik', 's1', 'r1')).toEqual([]);
  });

  it('adds a pick at the end, once', () => {
    expect(withPick([A], B)).toEqual([A, B]);
    expect(withPick([A, B], A)).toEqual([A, B]);
  });
});
