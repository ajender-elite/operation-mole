import type { JSX } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useSessionParams } from '../lib/session.ts';
import { betweenUrl, sessionPath } from '../lib/urls.ts';

/**
 * The Upstream page is now Between: commits on each side of two branches, with the ones the other side lacks.
 * Old links (`upstream?leftRepo&leftBranch&rightRepo&rightBranch`, and the old `lab` placeholder) open Between
 * with the same branches, on origin (the remote the old pages used). A link without the branches goes to the
 * Overview.
 */
export function UpstreamRedirect(): JSX.Element {
  const [params] = useSearchParams();
  const { user, sessionId } = useSessionParams();
  const repoId = params.get('leftRepo') ?? params.get('rightRepo') ?? '';
  const left = params.get('leftBranch') ?? '';
  const right = params.get('rightBranch') ?? '';
  if (repoId === '' || left === '' || right === '') {
    return <Navigate to={sessionPath(user, sessionId)} replace />;
  }
  return (
    <Navigate
      to={betweenUrl(
        user,
        sessionId,
        repoId,
        { remote: 'origin', branch: left },
        { remote: 'origin', branch: right },
      )}
      replace
    />
  );
}
