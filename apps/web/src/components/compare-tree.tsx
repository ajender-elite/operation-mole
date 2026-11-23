import type { CompareNode, EntryInfo } from '@om/shared';
import clsx from 'clsx';
import {
  ChevronRight,
  File,
  FileDiff,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  Link2,
} from 'lucide-react';
import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import { formatBytes } from '../lib/format.ts';
import { rowKey, type TreeRow } from '../lib/tree.ts';

type Side = 'left' | 'right';

type CompareTreeProps = {
  rows: TreeRow[];
  onToggle: (node: CompareNode) => void;
  onOpen: (node: CompareNode) => void;
  /** Called when a row gets keyboard or mouse focus. */
  onFocusRow?: (node: CompareNode) => void;
  /** Asks what accounts for a differing entry; offered on its row when given. */
  onExplain?: (node: CompareNode) => void;
  /** Paths to emphasize, e.g. where a selected commit accounts for differences. */
  highlighted?: ReadonlySet<string>;
};

const presentClass: Record<CompareNode['status'], string> = {
  identical: '',
  modified: 'bg-modified-soft text-modified',
  'only-left': 'bg-left-soft text-left',
  'only-right': 'bg-right-soft text-right',
  error: 'bg-error-soft text-error',
};

function EntryIcon({ info, open }: { info: EntryInfo; open: boolean }) {
  const className = 'size-4 shrink-0 opacity-80';
  if (info.kind === 'directory') {
    return open ? (
      <FolderOpen className={className} aria-hidden />
    ) : (
      <Folder className={className} aria-hidden />
    );
  }
  if (info.kind === 'symlink') return <Link2 className={className} aria-hidden />;
  return <File className={className} aria-hidden />;
}

function Cell({
  side,
  row,
  primary,
  onToggle,
}: {
  side: Side;
  row: TreeRow;
  /** The side whose chevron is exposed to assistive tech (the other is a visual duplicate). */
  primary: boolean;
  onToggle: () => void;
}) {
  const { node, depth } = row;
  const info = node[side];
  const hasDifferencesInside =
    row.isDirectory &&
    node.status === 'modified' &&
    node.left?.kind === 'directory' &&
    node.right?.kind === 'directory';
  const leafStatus = hasDifferencesInside ? 'identical' : node.status;

  return (
    <div
      data-testid={`cell-${side}`}
      data-present={info ? 'true' : 'false'}
      className={clsx(
        'flex min-w-0 items-center gap-1.5 py-1 pr-3',
        side === 'right' && 'border-l border-line',
        info ? presentClass[leafStatus] : 'bg-missing',
      )}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      {info && (
        <>
          {info.kind === 'directory' ? (
            <button
              type="button"
              tabIndex={-1}
              aria-hidden={primary ? undefined : true}
              aria-label={row.expanded ? 'Collapse' : 'Expand'}
              className="rounded p-0.5 hover:bg-hover"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
              }}
            >
              <ChevronRight
                className={clsx('size-3.5 transition-transform', row.expanded && 'rotate-90')}
                aria-hidden
              />
            </button>
          ) : (
            <span className="w-[18px] shrink-0" />
          )}
          <EntryIcon info={info} open={row.expanded} />
          <span className="truncate">{node.name}</span>
          <RenameNote node={node} side={side} />
          {hasDifferencesInside && (
            <span
              className="size-2 shrink-0 rounded-full bg-modified-dot"
              title="Contains differences"
            />
          )}
          {node.error !== undefined && node.error !== '' && (
            <span className="truncate text-xs" title={node.error}>
              ({node.error})
            </span>
          )}
          <span className="ml-auto shrink-0 pl-3 text-xs tabular-nums text-muted">
            {info.kind === 'file'
              ? formatBytes(info.size)
              : info.kind === 'symlink'
                ? `→ ${info.linkTarget ?? ''}`
                : ''}
          </span>
        </>
      )}
    </div>
  );
}

/** "renamed → new/path (92%)" on the Base side, "← old/path" on the Target side. */
function RenameNote({ node, side }: { node: CompareNode; side: Side }) {
  const other = side === 'left' ? node.renamedTo : node.renamedFrom;
  if (other === undefined) return null;
  return (
    <span
      className="shrink truncate rounded bg-surface/70 px-1 text-xs text-muted"
      title={`Git detected a rename (${node.similarity ?? 0}% similar)`}
    >
      {side === 'left' ? `renamed → ${other}` : `renamed from ${other}`}
      {node.similarity !== undefined && node.similarity < 100 ? ` (${node.similarity}%)` : ''}
    </span>
  );
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      title={label}
      aria-label={label}
      className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
      }}
    >
      {children}
    </button>
  );
}

function focusRow(row: Element | null): void {
  if (row instanceof HTMLElement) row.focus();
}

/** Side-by-side comparison rows: left tree and right tree aligned on the same row list. */
export function CompareTree({
  rows,
  onToggle,
  onOpen,
  onFocusRow,
  onExplain,
  highlighted,
}: CompareTreeProps): JSX.Element {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: TreeRow) => {
    const el = e.currentTarget;
    switch (e.key) {
      case 'Enter':
        onOpen(row.node);
        break;
      case 'ArrowRight':
        if (row.isDirectory && !row.expanded) onToggle(row.node);
        break;
      case 'ArrowLeft':
        if (row.isDirectory && row.expanded) onToggle(row.node);
        break;
      case 'ArrowDown':
        focusRow(el.nextElementSibling);
        break;
      case 'ArrowUp':
        focusRow(el.previousElementSibling);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  if (rows.length === 0) {
    return <p className="p-6 text-center text-sm text-muted">Nothing to show here.</p>;
  }

  return (
    <div role="tree" aria-label="Comparison" className="text-sm">
      {rows.map((row) => {
        const { node } = row;
        const primarySide: Side = node.left ? 'left' : 'right';
        return (
          <div
            key={rowKey(node)}
            role="treeitem"
            aria-label={node.name}
            aria-level={row.depth + 1}
            aria-expanded={row.isDirectory ? row.expanded : undefined}
            data-status={node.status}
            data-highlighted={highlighted?.has(node.path) === true ? 'true' : undefined}
            tabIndex={0}
            className={clsx(
              'group relative grid cursor-default select-none grid-cols-2 border-b border-line/60 outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent dark:hover:brightness-125',
              highlighted?.has(node.path) === true && 'shadow-[inset_4px_0_0_var(--color-accent)]',
            )}
            onFocus={(e) => {
              if (e.target === e.currentTarget) onFocusRow?.(node);
            }}
            onDoubleClick={() => {
              onOpen(node);
            }}
            onKeyDown={(e) => {
              onKeyDown(e, row);
            }}
          >
            <Cell
              side="left"
              row={row}
              primary={primarySide === 'left'}
              onToggle={() => {
                onToggle(node);
              }}
            />
            <Cell
              side="right"
              row={row}
              primary={primarySide === 'right'}
              onToggle={() => {
                onToggle(node);
              }}
            />
            <div className="absolute inset-y-0 right-1 hidden items-center gap-0.5 rounded bg-surface/95 px-1 shadow-sm group-focus-within:flex group-hover:flex">
              {onExplain && node.status !== 'identical' && node.status !== 'error' && (
                <ActionButton
                  label="Explain difference"
                  onClick={() => {
                    onExplain(node);
                  }}
                >
                  <GitCommitHorizontal className="size-4" aria-hidden />
                </ActionButton>
              )}
              {row.isDirectory ? (
                <ActionButton
                  label="Open folder"
                  onClick={() => {
                    onOpen(node);
                  }}
                >
                  <FolderOpen className="size-4" aria-hidden />
                </ActionButton>
              ) : (
                <ActionButton
                  label="Open diff"
                  onClick={() => {
                    onOpen(node);
                  }}
                >
                  <FileDiff className="size-4" aria-hidden />
                </ActionButton>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
