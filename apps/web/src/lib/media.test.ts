import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { stubViewport } from '../test/setup.ts';
import { MEDIA, useMediaQuery } from './media.ts';

const matches = (query: string): boolean => renderHook(() => useMediaQuery(query)).result.current;

describe('useMediaQuery', () => {
  it('a phone held upright is compact and touch, not short', () => {
    stubViewport({ width: 390, height: 844, pointer: 'coarse' });
    expect(matches(MEDIA.compact)).toBe(true);
    expect(matches(MEDIA.short)).toBe(false);
    expect(matches(MEDIA.coarse)).toBe(true);
    expect(matches(MEDIA.wide)).toBe(false);
  });

  it('a phone in landscape is short and not compact', () => {
    stubViewport({ width: 844, height: 390, pointer: 'coarse' });
    expect(matches(MEDIA.short)).toBe(true);
    expect(matches(MEDIA.compact)).toBe(false);
  });

  it('a tablet in portrait is neither compact nor wide', () => {
    stubViewport({ width: 768, height: 1024, pointer: 'coarse' });
    expect(matches(MEDIA.compact)).toBe(false);
    expect(matches(MEDIA.wide)).toBe(false);
    expect(matches(MEDIA.short)).toBe(false);
  });

  it('a desktop with a mouse is wide and fine-pointed', () => {
    stubViewport({ width: 1280, height: 800, pointer: 'fine' });
    expect(matches(MEDIA.wide)).toBe(true);
    expect(matches(MEDIA.coarse)).toBe(false);
  });
});

describe('responsive CSS', () => {
  const css = readFileSync(path.join(import.meta.dirname, '..', 'index.css'), 'utf8');

  it('defines the coarse and short variants and the touch target utility', () => {
    expect(css).toMatch(/@custom-variant coarse \(@media \(pointer: coarse\)\);/);
    expect(css).toMatch(/@custom-variant short \(@media \(max-height: 480px\)\);/);
    expect(css).toMatch(/@utility touch-target/);
  });
});
