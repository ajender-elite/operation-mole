import { describe, expect, it } from 'vitest';
import { compareNames } from '../src/compare/sort.ts';

const sorted = (names: string[]) => [...names].sort(compareNames);

describe('compareNames', () => {
  it('sorts ascending, ignoring case', () => {
    expect(sorted(['README.md', 'notes.txt', 'LICENSE', 'config.json'])).toEqual([
      'config.json',
      'LICENSE',
      'notes.txt',
      'README.md',
    ]);
  });

  it('orders numbers by value (natural order)', () => {
    expect(sorted(['file10.txt', 'file2.txt', 'file1.txt'])).toEqual([
      'file1.txt',
      'file2.txt',
      'file10.txt',
    ]);
  });

  it('breaks ties between names differing only in case deterministically', () => {
    expect(sorted(['a.txt', 'A.txt'])).toEqual(['A.txt', 'a.txt']);
    expect(sorted(['A.txt', 'a.txt'])).toEqual(['A.txt', 'a.txt']);
  });

  // Names every real repository has: leading symbols and dots, digits, mixed case, accents.
  it('orders symbols, dots, numbers by value, letters ignoring case, and accents', () => {
    expect(
      sorted([
        'Z.txt',
        'résumé.txt',
        'report.txt',
        'my notes.txt',
        'file10.txt',
        'File3.txt',
        'file2.txt',
        'file1.txt',
        'c.txt',
        'B.txt',
        'a.txt',
        '10-ten.txt',
        '9-nine.txt',
        '.env',
        '_notes.txt',
      ]),
    ).toEqual([
      '_notes.txt',
      '.env',
      '9-nine.txt',
      '10-ten.txt',
      'a.txt',
      'B.txt',
      'c.txt',
      'file1.txt',
      'file2.txt',
      'File3.txt',
      'file10.txt',
      'my notes.txt',
      'report.txt',
      'résumé.txt',
      'Z.txt',
    ]);
    expect(
      sorted(['Zulu', 'v10', 'v2', 'beta', 'Alpha', '2024-archive', '.config', '_private']),
    ).toEqual(['_private', '.config', '2024-archive', 'Alpha', 'beta', 'v2', 'v10', 'Zulu']);
  });

  it('orders numeric names by value, keeping zero-padded and decimal names apart', () => {
    expect(sorted(['1000', '100', '20', '10', '7', '007', '3', '2', '1'])).toEqual([
      '1',
      '2',
      '3',
      '007',
      '7',
      '10',
      '20',
      '100',
      '1000',
    ]);
    expect(
      sorted([
        '1000.log',
        '100.txt',
        '50',
        '20.md',
        '10.txt',
        '5',
        '3.csv',
        '2.txt',
        '1.txt',
        '01.txt',
        '1.5.txt',
      ]),
    ).toEqual([
      '1.5.txt',
      '01.txt',
      '1.txt',
      '2.txt',
      '3.csv',
      '5',
      '10.txt',
      '20.md',
      '50',
      '100.txt',
      '1000.log',
    ]);
  });
});
