import type { CherryPickStep } from '@om/shared';

/**
 * How many branch checks run at once: each is a merge per pick, so a few at a time keeps the server responsive.
 * Used wherever a series or a commit is checked on many branches.
 */
export const CHECKS_AT_ONCE = 3;

/** What a step's status says, in git's words (never "missing" or "safe"). */
export const STATUS_TEXT: Record<CherryPickStep['status'], string> = {
  applies: 'Would apply',
  'no-change': 'Change already present',
  'in-history': 'In history',
  conflict: 'Would conflict',
  'not-run': 'Not checked',
};
