import { describe, expect, it } from 'vitest';
import { highlightLines, languageFor, MAX_HIGHLIGHT_LINES } from './highlight.ts';

describe('languageFor', () => {
  it('names the grammar of a file by its extension', () => {
    expect(languageFor('src/app.tsx')).toBe('tsx');
    expect(languageFor('lib/Util.TS')).toBe('typescript');
    expect(languageFor('docs/README.md')).toBe('markdown');
  });

  it('has no grammar for a file it does not know, or a name without an extension', () => {
    expect(languageFor('bin/tool')).toBeUndefined();
    expect(languageFor('.gitignore')).toBeUndefined();
    expect(languageFor('notes.xyz')).toBeUndefined();
  });
});

describe('highlightLines', () => {
  it('returns each line of the file as tokens, coloured by CSS variables', async () => {
    const lines = await highlightLines('const answer = 42;\nconsole.log(answer);\n', 'a.ts');
    expect(lines).toHaveLength(3);
    const first = lines?.[0] ?? [];
    expect(first.map((t) => t.content).join('')).toBe('const answer = 42;');
    const keyword = first.find((t) => t.content === 'const');
    expect(keyword?.color).toContain('var(--color-syntax-');
  }, 30_000);

  it('gives plain text (undefined) for a file with no grammar', async () => {
    expect(await highlightLines('just words', 'notes.xyz')).toBeUndefined();
  });

  it('gives plain text for a file with too many lines', async () => {
    const big = 'x\n'.repeat(MAX_HIGHLIGHT_LINES + 1);
    expect(await highlightLines(big, 'big.ts')).toBeUndefined();
  });
});
