import { useEffect, useState, useCallback } from 'react';
import { amSupabase } from './amSupabase.js';
import { useAmLatest } from './amHooks.js';

let amChannelSeq = 0;

/**
 * Subscribe to postgres_changes. RLS decides which rows the user receives.
 * specs: [{ event, table, filter }]
 */
export function useAmPostgresChanges(key, specs, onChange, enabled = true, onStatus) {
  const handler = useAmLatest(onChange);
  const statusHandler = useAmLatest(onStatus);
  const specsKey = JSON.stringify(specs);
  useEffect(() => {
    if (!enabled || !amSupabase) return undefined;
    const channel = amSupabase.channel(`am-${key}-${++amChannelSeq}`);
    for (const s of JSON.parse(specsKey)) {
      channel.on('postgres_changes', { event: s.event ?? '*', schema: 'public', table: s.table, ...(s.filter ? { filter: s.filter } : {}) }, (payload) =>
        handler.current(payload),
      );
    }
    channel.subscribe((status, details) => {
      statusHandler.current?.(status, details);
    });
    return () => {
      amSupabase.removeChannel(channel);
    };
  }, [key, specsKey, enabled, handler, statusHandler]);
}

/** Total unread messages across threads (for nav badges). */
export function useAmUnread(userId) {
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(async () => {
    if (!userId) return;
    const { data } = await amSupabase.rpc('am_list_conversations');
    setUnread((data ?? []).reduce((sum, c) => sum + (c.unread || 0), 0));
  }, [userId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useAmPostgresChanges('unread', [{ event: 'INSERT', table: 'messages' }, { event: 'UPDATE', table: 'conversation_members', filter: `user_id=eq.${userId}` }], refresh, !!userId);
  return { unread, refresh };
}
