import { createContext } from 'react';

/**
 * The app header's middle slot. In landscape on a phone the session's tab strip moves here, so the
 * header and the tabs share one row (SessionWorkspace portals into it; see `short:` in docs/frontend.md).
 */
export const HeaderSlotContext = createContext<HTMLElement | null>(null);
