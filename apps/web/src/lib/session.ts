import type { AddRemoteRequest, RemoteCheck, RepoInfo, SessionDetail } from '@om/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useParams } from 'react-router';
import {
  addRemote,
  addRepo,
  checkRemote,
  deleteRepo,
  fetchRemote,
  fetchRepo,
  getSession,
  removeRemote,
} from './api.ts';

/** TanStack Query key for a session's detail; shared so mutations can update the cached copy. */
export const sessionKey = (user: string, sessionId: string) =>
  ['session', user, sessionId] as const;

/** `user` and `sessionId` from the current route ('' when absent). */
export function useSessionParams(): { user: string; sessionId: string } {
  const { user = '', sessionId = '' } = useParams();
  return { user, sessionId };
}

/** Loads a session's detail; disabled until both `user` and `sessionId` are known. */
export function useSessionDetail(user: string, sessionId: string): UseQueryResult<SessionDetail> {
  return useQuery({
    queryKey: sessionKey(user, sessionId),
    queryFn: () => getSession(user, sessionId),
    enabled: user !== '' && sessionId !== '',
  });
}

/** Mutations exposed by {@link useRepoActions}. */
export type RepoActions = {
  add: UseMutationResult<RepoInfo, Error, string>;
  fetchLatest: UseMutationResult<RepoInfo, Error, string>;
  remove: UseMutationResult<void, Error, string>;
  addRemote: UseMutationResult<RepoInfo, Error, { repoId: string; remote: AddRemoteRequest }>;
  fetchRemote: UseMutationResult<RepoInfo, Error, { repoId: string; name: string }>;
  removeRemote: UseMutationResult<void, Error, { repoId: string; name: string }>;
  checkRemote: UseMutationResult<RemoteCheck, Error, { repoId: string; name: string }>;
};

/** Clone/fetch mutations that keep the cached session's repo list current. */
export function useRepoActions(user: string, sessionId: string): RepoActions {
  const queryClient = useQueryClient();
  const key = sessionKey(user, sessionId);

  const remember = (repo: RepoInfo) => {
    queryClient.setQueryData<SessionDetail>(
      key,
      (detail) =>
        detail && {
          ...detail,
          repos: detail.repos.some((r) => r.id === repo.id)
            ? detail.repos.map((r) => (r.id === repo.id ? repo : r))
            : [...detail.repos, repo],
        },
    );
    void queryClient.invalidateQueries({ queryKey: key });
  };

  const add = useMutation({
    mutationFn: (url: string) => addRepo(user, sessionId, url),
    onSuccess: remember,
  });
  const fetchLatest = useMutation({
    mutationFn: (repoId: string) => fetchRepo(user, sessionId, repoId),
    onSuccess: remember,
  });
  const remove = useMutation({
    mutationFn: (repoId: string) => deleteRepo(user, sessionId, repoId),
    onSuccess: (_result, repoId) => {
      queryClient.setQueryData<SessionDetail>(
        key,
        (detail) => detail && { ...detail, repos: detail.repos.filter((r) => r.id !== repoId) },
      );
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const addRemoteAction = useMutation({
    mutationFn: ({ repoId, remote }: { repoId: string; remote: AddRemoteRequest }) =>
      addRemote(user, sessionId, repoId, remote),
    onSuccess: remember,
  });
  const fetchRemoteAction = useMutation({
    mutationFn: ({ repoId, name }: { repoId: string; name: string }) =>
      fetchRemote(user, sessionId, repoId, name),
    onSuccess: remember,
  });
  const removeRemoteAction = useMutation({
    mutationFn: ({ repoId, name }: { repoId: string; name: string }) =>
      removeRemote(user, sessionId, repoId, name),
    onSuccess: (_result, { repoId, name }) => {
      queryClient.setQueryData<SessionDetail>(
        key,
        (detail) =>
          detail && {
            ...detail,
            repos: detail.repos.map((r) =>
              r.id === repoId ? { ...r, remotes: r.remotes.filter((x) => x.name !== name) } : r,
            ),
          },
      );
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const checkRemoteAction = useMutation({
    mutationFn: ({ repoId, name }: { repoId: string; name: string }) =>
      checkRemote(user, sessionId, repoId, name),
  });
  return {
    add,
    fetchLatest,
    remove,
    addRemote: addRemoteAction,
    fetchRemote: fetchRemoteAction,
    removeRemote: removeRemoteAction,
    checkRemote: checkRemoteAction,
  };
}
