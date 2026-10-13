import { useCallback, useEffect, useRef, useState } from 'react';
import { amSupabase } from './amSupabase.js';
import { amValidateAttachment, amSafeFileName } from '../../shared/amAttachments.js';
import { useAmPostgresChanges } from './amRealtime.js';

export function amMergeChatMessages(current, incoming) {
  const merged = new Map();
  for (const msg of [...(current ?? []), ...(Array.isArray(incoming) ? incoming : [incoming])]) {
    if (!msg) continue;
    const key = msg.id || `${msg.sender_id}:${msg.created_at}:${msg.body ?? ''}:${msg.attachment_path ?? ''}`;
    merged.set(key, msg);
  }
  return [...merged.values()].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

/**
 * Chat for a conversation. Pass conversationId for an existing thread, or
 * memberIds (the other participants) to resolve the thread eagerly so incoming
 * messages show up before this user sends anything. If eager resolution fails,
 * the thread is created lazily on first send instead.
 */
export function useAmChat({ conversationId: initialId, memberIds, sessionId }) {
  const [conversationId, setConversationId] = useState(initialId ?? null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(!!initialId);
  const [error, setError] = useState(null);
  const idRef = useRef(conversationId);
  idRef.current = conversationId;
  // memberIds is a fresh array every render; key effects on a stable string.
  const memberKey = [...(memberIds ?? [])].sort().join(',');
  const memberIdsRef = useRef(memberIds);
  memberIdsRef.current = memberIds;
  // Shared in-flight RPC so the eager resolve and a send never double-call it.
  const pendingRef = useRef(null);

  const load = useCallback(async (id) => {
    if (!id) return;
    const { data, error: loadError } = await amSupabase
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .limit(500);
    if (loadError) {
      setError(loadError.message || 'Could not load messages.');
      setLoading(false);
      return;
    }
    setMessages((current) => amMergeChatMessages(current, data ?? []));
    setError(null);
    setLoading(false);
    amSupabase.from('conversation_members').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', id).then(() => {});
  }, []);

  useEffect(() => {
    if (initialId) {
      setConversationId(initialId);
      load(initialId);
    }
  }, [initialId, load]);

  const resolveConversation = useCallback((key, ids) => {
    if (pendingRef.current?.key === key) return pendingRef.current.promise;
    const promise = Promise.resolve()
      .then(() => amSupabase.rpc('am_get_or_create_conversation', { p_member_ids: ids }))
      .then(
        ({ data, error: err }) => (err || !data ? { error: err?.message ?? 'Could not open this chat.' } : { data }),
        (err) => ({ error: err?.message ?? 'Could not open this chat.' }),
      );
    pendingRef.current = { key, promise };
    promise.then((res) => {
      // Allow a retry (lazy, on send) after a failure.
      if (res.error && pendingRef.current?.promise === promise) pendingRef.current = null;
    });
    return promise;
  }, []);

  // Eagerly resolve the thread when only memberIds are known (video sessions).
  useEffect(() => {
    if (initialId || !memberKey || idRef.current) return undefined;
    let active = true;
    setLoading(true);
    resolveConversation(memberKey, memberIdsRef.current).then((res) => {
      if (!active) return;
      if (res.error) {
        setError(res.error);
        setLoading(false);
        return;
      }
      setError(null);
      if (idRef.current) return;
      idRef.current = res.data;
      setConversationId(res.data);
      load(res.data);
    });
    return () => {
      active = false;
    };
  }, [initialId, memberKey, load, resolveConversation]);

  useAmPostgresChanges(
    'chat',
    [{ event: 'INSERT', table: 'messages', filter: conversationId ? 'conversation_id=eq.' + conversationId : undefined }],
    ({ new: msg }) => {
      setMessages((prev) => amMergeChatMessages(prev, msg));
      if (document.visibilityState === 'visible' && conversationId) {
        amSupabase.from('conversation_members').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', conversationId).then(() => {});
      }
    },
    !!conversationId,
    (status, details) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setError(details?.message || 'Live chat disconnected. Your messages are still saved.');
      }
    },
  );

  const ensureConversation = useCallback(async () => {
    if (idRef.current) return idRef.current;
    const ids = memberIdsRef.current ?? [];
    if (!ids.length) throw new Error('Chat is still connecting. Try again in a moment.');
    const res = await resolveConversation([...ids].sort().join(','), ids);
    if (res.error) throw new Error(res.error);
    setError(null);
    if (idRef.current) return idRef.current;
    setConversationId(res.data);
    idRef.current = res.data;
    load(res.data);
    return res.data;
  }, [resolveConversation, load]);

  const uploadAttachment = useCallback(async (convId, file) => {
    const path = convId + '/' + Date.now() + '-' + amSafeFileName(file.name);
    const { error } = await amSupabase.storage.from('chat-attachments').upload(path, file, { contentType: file.type });
    if (error) throw new Error(error.message);
    return path;
  }, []);

  const send = useCallback(
    async ({ body, file }) => {
      const text = (body ?? '').trim();
      if (!text && !file) return;
      if (file) {
        const err = amValidateAttachment(file);
        if (err) throw new Error(err);
      }
      const convId = await ensureConversation();
      let attachment = {};
      if (file) {
        const path = await uploadAttachment(convId, file);
        attachment = { attachment_path: path, attachment_name: file.name.slice(0, 120), attachment_type: file.type, attachment_size: file.size };
      }
      const { data: authData, error: authError } = await amSupabase.auth.getUser();
      if (authError || !authData?.user?.id) throw new Error(authError?.message || 'You need to sign in again.');
      const { data: inserted, error } = await amSupabase.from('messages').insert({
        conversation_id: convId,
        sender_id: authData.user.id,
        session_id: sessionId ?? null,
        body: text || null,
        ...attachment,
      }).select('*').single();
      if (error) throw new Error(error.message);
      if (inserted) setMessages((current) => amMergeChatMessages(current, inserted));
    },
    [ensureConversation, uploadAttachment, sessionId],
  );

  // Sending needs either a thread or someone to start one with.
  const ready = !!conversationId || memberKey.length > 0;

  return { conversationId, messages, loading, error, ready, send };
}

export function amAttachmentUrl(path) {
  return amSupabase.storage.from('chat-attachments').createSignedUrl(path, 3600).then(({ data }) => data?.signedUrl ?? null);
}
