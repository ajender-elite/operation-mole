import type { ServerInfo } from '@om/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { getServerInfo } from './api.ts';

/**
 * The server's git and limits (`GET /api/server`). They change only when the server restarts, so
 * they are fetched once for the page's life.
 */
export function useServerInfo(): UseQueryResult<ServerInfo> {
  return useQuery({ queryKey: ['server-info'], queryFn: getServerInfo, staleTime: Infinity });
}
