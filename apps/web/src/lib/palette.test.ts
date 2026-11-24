import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Eye-comfort palette (docs/frontend.md, "Colour and eye comfort"). The tokens live in index.css:
 * the @theme block holds the dark default, and :root[data-theme='light'] holds the light theme.
 * These tests read the stylesheet itself, so a palette edit cannot quietly drop readability.
 */

const css = readFileSync(path.join(import.meta.dirname, '..', 'index.css'), 'utf8');

/** Colour tokens declared in a CSS block, as `name -> #rrggbb`. */
function colorsIn(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\b/gi)) {
    if (name !== undefined && value !== undefined) tokens.set(name, value.toLowerCase());
  }
  return tokens;
}

const darkBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
const lightBlock = /:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
const dark = colorsIn(darkBlock);
const light = colorsIn(lightBlock);

/** Every token the components use; both themes must define all of them. */
const REQUIRED = [
  'canvas',
  'surface',
  'ink',
  'muted',
  'line',
  'hover',
  'accent',
  'accent-soft',
  'side-left',
  'side-left-soft',
  'side-left-dot',
  'side-right',
  'side-right-soft',
  'side-right-dot',
  'modified',
  'modified-soft',
  'modified-dot',
  'error',
  'error-soft',
  'error-dot',
  'ok',
  'missing',
] as const;

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_MIN = 4.5; // WCAG AA, normal text
const GRAPHIC_MIN = 3; // WCAG 1.4.11, meaningful non-text marks

/** Text colour on a background it is drawn over. */
const TEXT_PAIRS: Array<[string, string]> = [
  ['ink', 'canvas'],
  ['ink', 'surface'],
  ['ink', 'hover'],
  ['ink', 'accent-soft'],
  ['ink', 'side-left-soft'],
  ['ink', 'side-right-soft'],
  ['ink', 'modified-soft'],
  ['ink', 'error-soft'],
  ['muted', 'canvas'],
  ['muted', 'surface'],
  ['muted', 'hover'],
  ['accent', 'canvas'],
  ['accent', 'surface'],
  ['accent', 'accent-soft'],
  ['side-left', 'canvas'],
  ['side-left', 'surface'],
  ['side-left', 'side-left-soft'],
  ['side-right', 'canvas'],
  ['side-right', 'surface'],
  ['side-right', 'side-right-soft'],
  ['modified', 'canvas'],
  ['modified', 'surface'],
  ['modified', 'modified-soft'],
  ['error', 'canvas'],
  ['error', 'surface'],
  ['error', 'error-soft'],
  ['ok', 'surface'],
];

/** Status dots and other meaningful marks, against the surface they sit on. */
const GRAPHIC_PAIRS: Array<[string, string]> = [
  ['side-left-dot', 'surface'],
  ['side-right-dot', 'surface'],
  ['modified-dot', 'surface'],
  ['error-dot', 'surface'],
];

const themes = { dark, light } as const;

describe('palette', () => {
  for (const [theme, tokens] of Object.entries(themes)) {
    it(`${theme} theme defines every token`, () => {
      const missing = REQUIRED.filter((name) => !tokens.has(name));
      expect(missing).toEqual([]);
    });

    it(`${theme} theme uses no pure black or white`, () => {
      const harsh = [...tokens].filter(([, value]) => ['#000000', '#ffffff'].includes(value));
      expect(harsh).toEqual([]);
    });

    it(`${theme} theme keeps text at WCAG AA contrast`, () => {
      const failures = TEXT_PAIRS.map(([text, background]) => {
        const textValue = tokens.get(text);
        const backgroundValue = tokens.get(background);
        if (textValue === undefined || backgroundValue === undefined) {
          return `${text} on ${background}: token missing`;
        }
        const ratio = contrast(textValue, backgroundValue);
        return ratio >= TEXT_MIN ? undefined : `${text} on ${background}: ${ratio.toFixed(2)}:1`;
      }).filter((failure): failure is string => failure !== undefined);
      expect(failures).toEqual([]);
    });

    it(`${theme} theme keeps status marks at 3:1 against the surface`, () => {
      const failures = GRAPHIC_PAIRS.map(([mark, background]) => {
        const markValue = tokens.get(mark);
        const backgroundValue = tokens.get(background);
        if (markValue === undefined || backgroundValue === undefined) {
          return `${mark} on ${background}: token missing`;
        }
        const ratio = contrast(markValue, backgroundValue);
        return ratio >= GRAPHIC_MIN ? undefined : `${mark} on ${background}: ${ratio.toFixed(2)}:1`;
      }).filter((failure): failure is string => failure !== undefined);
      expect(failures).toEqual([]);
    });
  }

  it('dark body text stays below 13:1 to avoid glare', () => {
    const ink = dark.get('ink') ?? '#000000';
    for (const background of ['canvas', 'surface'] as const) {
      const value = dark.get(background) ?? '#ffffff';
      expect(contrast(ink, value)).toBeLessThan(13);
    }
  });
});
