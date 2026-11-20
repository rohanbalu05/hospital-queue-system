import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReadAllResult, UnreadCount, type Id, type Notification } from '@hqms/contracts';
import { apiFetch, type ApiRequestError } from '@/lib/api';
import { get } from './queries';
import { NotificationList } from './schemas';

export const notificationKeys = {
  all: ['notifications'] as const,
  list: ['notifications', 'list'] as const,
  unread: ['notifications', 'unread-count'] as const,
};

/** The bell polls this often, and also refetches on window focus and when a live queue notice arrives. */
export const UNREAD_POLL_MS = 15_000;

/** GET /notifications/unread-count (own). Cheap. */
export function useUnreadCount(options: { enabled?: boolean } = {}) {
  return useQuery<UnreadCount, ApiRequestError>({
    queryKey: notificationKeys.unread,
    queryFn: ({ signal }) => get('/notifications/unread-count', {}, UnreadCount, signal),
    refetchInterval: UNREAD_POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
    enabled: options.enabled ?? true,
  });
}

/** GET /notifications (own, newest first, max 100). Fetched when the list is opened. */
export function useNotifications(options: { enabled?: boolean } = {}) {
  return useQuery<Notification[], ApiRequestError>({
    queryKey: notificationKeys.list,
    queryFn: ({ signal }) => get('/notifications', {}, NotificationList, signal),
    refetchOnWindowFocus: true,
    staleTime: 0,
    enabled: options.enabled ?? true,
  });
}

/** POST /notifications/{id}/read */
export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation<unknown, ApiRequestError, { id: Id }>({
    mutationFn: ({ id }) => apiFetch(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: (_d, { id }) => {
      // Reflect it at once; the refetch below confirms it.
      const at = new Date().toISOString();
      qc.setQueryData<Notification[]>(notificationKeys.list, (old) => old?.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: at } : n)));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

/** POST /notifications/read-all */
export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation<ReadAllResult, ApiRequestError>({
    mutationFn: () => apiFetch('/notifications/read-all', { method: 'POST', schema: ReadAllResult }),
    onSuccess: () => {
      const at = new Date().toISOString();
      qc.setQueryData<Notification[]>(notificationKeys.list, (old) => old?.map((n) => (n.readAt ? n : { ...n, readAt: at })));
      qc.setQueryData<UnreadCount>(notificationKeys.unread, { unreadCount: 0 });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

/**
 * Refetch notifications whenever a live queue snapshot is refreshed by a version notice. Screens that already hold an
 * SSE stream (My visit, doctor console, reception, ...) update their snapshot query when a notice arrives; this watches
 * the query cache for that instead of opening a second stream.
 */
export function useRefreshOnLiveNotice(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const [a, b] = event.query.queryKey;
      if (a === 'queue' && b === 'snapshot') void qc.invalidateQueries({ queryKey: notificationKeys.all });
    });
  }, [qc]);
}
