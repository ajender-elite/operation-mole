import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages, type BundledLanguage } from 'shiki/langs';

/**
 * Syntax highlighting for the code view (Shiki, fine-grained core with the JavaScript regex engine, so no
 * WebAssembly). A grammar loads the first time a file of its language is shown. Token colours are CSS
 * variables named `--color-syntax-*` (index.css), so both themes and the palette rules apply to code too.
 */

/** Files above this many bytes or lines are shown as plain text (highlighting them costs more than it adds). */
export const MAX_HIGHLIGHT_BYTES = 200_000;
export const MAX_HIGHLIGHT_LINES = 5000;

/** The Shiki theme: every token colour is a `--color-syntax-*` variable. */
const THEME_NAME = 'om-syntax';
const theme = createCssVariablesTheme({ name: THEME_NAME, variablePrefix: '--color-syntax-' });

/** A file extension (lower case, no dot) and the grammar it is highlighted with. */
const LANGUAGE_BY_EXTENSION: Record<string, BundledLanguage> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  py: 'python',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  java: 'java',
  rb: 'ruby',
  css: 'css',
  html: 'html',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shellscript',
};

/** The grammar for a file, by its name's extension, or undefined when OM has none (shown as plain text). */
export function languageFor(filePath: string): BundledLanguage | undefined {
  const name = filePath.split('/').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}

/** One highlighted run of text. `color` is a CSS value (a variable); absent means the default colour. */
export type HighlightedToken = { content: string; color?: string | undefined };

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Set<BundledLanguage>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [theme],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

async function ensureLanguage(core: HighlighterCore, language: BundledLanguage): Promise<void> {
  if (loaded.has(language)) return;
  const grammar = await bundledLanguages[language]();
  await core.loadLanguage(grammar);
  loaded.add(language);
}

/**
 * The lines of a file, each as highlighted tokens, or undefined when the file is shown as plain text (no
 * grammar for its type, or too large). Line N of the result is line N of the file.
 */
export async function highlightLines(
  text: string,
  filePath: string,
): Promise<HighlightedToken[][] | undefined> {
  const language = languageFor(filePath);
  if (language === undefined) return undefined;
  if (text.length > MAX_HIGHLIGHT_BYTES) return undefined;
  if (text.split('\n').length > MAX_HIGHLIGHT_LINES) return undefined;
  const core = await getHighlighter();
  await ensureLanguage(core, language);
  const lines = core.codeToTokensBase(text, { lang: language, theme: THEME_NAME });
  return lines.map((line) =>
    line.map((token) => ({
      content: token.content,
      ...(token.color === undefined ? {} : { color: token.color }),
    })),
  );
}
