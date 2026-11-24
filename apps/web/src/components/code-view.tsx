import clsx from 'clsx';
import type { JSX, ReactNode } from 'react';
import type { CodeRow } from '../lib/code-lines.ts';
import type { HighlightedToken } from '../lib/highlight.ts';

/**
 * A file's lines with their numbers, an optional gutter per line (the blame tag), and an optional range
 * to highlight. Presentational: the rows come from `codeRows`, the gutter from the caller, and the colours
 * (`tokens`, one list per line) from `highlightLines`; without them the text shows plain.
 */
export function CodeView({
  label,
  rows,
  highlight,
  gutter,
  tokens,
}: {
  /** What the listing is, for screen readers (the file's path). */
  label: string;
  rows: CodeRow[];
  highlight?: { start: number; end: number } | undefined;
  gutter?: ((row: CodeRow) => ReactNode) | undefined;
  tokens?: HighlightedToken[][] | undefined;
}): JSX.Element {
  return (
    <div className="overflow-auto font-mono text-[13px] leading-6">
      <table aria-label={label} className="min-w-full border-collapse">
        <tbody>
          {rows.map((row) => {
            const isHighlighted =
              highlight !== undefined &&
              row.number >= highlight.start &&
              row.number <= highlight.end;
            return (
              <tr
                key={row.number}
                data-line={row.number}
                className={clsx(isHighlighted && 'bg-accent-soft')}
              >
                {gutter !== undefined && (
                  <td className="w-0 select-none whitespace-nowrap border-r border-line px-2 align-top text-xs text-muted">
                    {gutter(row)}
                  </td>
                )}
                <th
                  scope="row"
                  className="w-0 select-none whitespace-nowrap px-3 text-right font-normal text-muted"
                >
                  {row.number}
                </th>
                <td className="whitespace-pre pr-4 text-ink">
                  {tokens?.[row.number - 1]?.map((token, index) => (
                    <span
                      // Tokens of one line never reorder, so their position is a stable key.
                      key={index}
                      style={token.color === undefined ? undefined : { color: token.color }}
                    >
                      {token.content}
                    </span>
                  )) ?? row.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
