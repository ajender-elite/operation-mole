import { Server } from 'lucide-react';
import { useId, useState, type JSX } from 'react';
import { useServerInfo } from '../lib/server.ts';

/**
 * The header's git chip: the version of the server's git. Opens a panel of what it can reach: the
 * protocols, whether an SSH agent is set, and the limits. Names and flags only, never a URL or a
 * credential.
 */
export function ServerInfoChip(): JSX.Element | null {
  const info = useServerInfo();
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();
  if (!info.isSuccess) return null;
  const { git, access, limits } = info.data;

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => {
          setIsOpen((open) => !open);
        }}
        className="flex items-center gap-1.5 rounded-md border border-line px-2 py-0.5 font-mono text-xs text-muted hover:bg-hover hover:text-ink"
      >
        <Server className="size-3.5" aria-hidden />
        Git {git.version}
      </button>
      {isOpen && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Git on this server"
          className="absolute right-0 top-full z-30 mt-1 w-80 max-w-[90vw] space-y-2 rounded-md border border-line bg-surface p-3 text-sm shadow-lg"
        >
          <p>
            Version <span className="font-mono">{git.version}</span>
          </p>
          <p>
            Protocols: <span className="font-mono">{access.protocols.join(', ')}</span>
          </p>
          <p className="text-muted">
            Uses this server’s git config and credentials. Git never asks for a password here.
          </p>
          <p>SSH agent: {access.hasSshAgent ? 'available' : 'not set'}</p>
          <p>
            Limits: {limits.sessionsPerUser} sessions per user · {limits.reposPerSession}{' '}
            repositories per session · {limits.remotesPerRepo} remotes per repo
          </p>
        </div>
      )}
    </div>
  );
}
