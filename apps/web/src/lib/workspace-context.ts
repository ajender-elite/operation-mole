import { createContext, useContext } from 'react';
import { useNavigate } from 'react-router';

/** How to open a working context; see {@link useWorkspace}. */
export type OpenOptions = {
  /** Show exactly this URL, even in an equivalent open tab (default: focus that tab as it was left). */
  isExact?: boolean;
  /** The new context takes the place of the current tab (e.g. after changing its sources). */
  isReplacing?: boolean;
};

/** Opens the session's working contexts, each in its own tab. */
export type Workspace = {
  /** Opens `url` in its own tab, or focuses the equivalent tab if one is open. */
  open: (url: string, options?: OpenOptions) => void;
};

/** Provided by the session workspace (`components/session-workspace.tsx`). */
export const WorkspaceContext = createContext<Workspace | undefined>(undefined);

/** The session's tabs; outside a session workspace, plain navigation. */
export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  const navigate = useNavigate();
  return workspace ?? { open: (url) => void navigate(url) };
}
