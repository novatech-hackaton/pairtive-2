import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const amMock = vi.hoisted(() => ({ messages: [], loadedIds: [], realtimeEnabled: [], inserted: null }));

vi.mock('./amSupabase.js', () => {
  const messagesQuery = () => {
    let insertPayload = null;
    const q = {
      select: () => q,
      eq: (_col, id) => (amMock.loadedIds.push(id), q),
      order: () => q,
      limit: async () => ({ data: amMock.messages, error: null }),
      insert: (payload) => (insertPayload = payload, q),
      single: async () => {
        const inserted = { id: 'm2', created_at: '2024-01-01T00:01:00Z', ...insertPayload };
        amMock.inserted = inserted;
        return { data: inserted, error: null };
      },
    };
    return q;
  };
  const membersQuery = () => ({ update: () => ({ eq: async () => ({ error: null }) }) });
  return {
    amSupabase: {
      rpc: vi.fn(),
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } }, error: null })) },
      from: (table) => (table === 'messages' ? messagesQuery() : membersQuery()),
    },
  };
});
vi.mock('./amRealtime.js', () => ({
  useAmPostgresChanges: (_name, _filters, _cb, enabled) => amMock.realtimeEnabled.push(enabled),
}));

const { amSupabase } = await import('./amSupabase.js');
const { useAmChat } = await import('./amChat.js');

const msg = { id: 'm1', conversation_id: 'c1', sender_id: 'u2', body: 'hi', created_at: '2024-01-01T00:00:00Z' };

beforeEach(() => {
  amSupabase.rpc.mockReset();
  amMock.messages = [msg];
  amMock.loadedIds = [];
  amMock.realtimeEnabled = [];
  amMock.inserted = null;
  amSupabase.auth.getUser.mockClear();
});

describe('useAmChat', () => {
  it('resolves the conversation eagerly from memberIds and loads its messages', async () => {
    amSupabase.rpc.mockResolvedValue({ data: 'c1', error: null });
    // New array each render, like the session page passes.
    const { result, rerender } = renderHook(() => useAmChat({ memberIds: ['u2', 'u3'], sessionId: 's1' }));
    rerender();
    rerender();

    await waitFor(() => expect(result.current.conversationId).toBe('c1'));
    await waitFor(() => expect(result.current.messages).toEqual([msg]));
    expect(amSupabase.rpc).toHaveBeenCalledTimes(1);
    expect(amSupabase.rpc).toHaveBeenCalledWith('am_get_or_create_conversation', { p_member_ids: ['u2', 'u3'] });
    expect(amMock.loadedIds).toContain('c1');
    expect(result.current.ready).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(amMock.realtimeEnabled.at(-1)).toBe(true);
  });

  it('does not call the rpc and is not ready while memberIds is empty', async () => {
    const { result, rerender } = renderHook(({ ids }) => useAmChat({ memberIds: ids, sessionId: 's1' }), { initialProps: { ids: [] } });
    rerender({ ids: [] });
    await Promise.resolve();
    expect(amSupabase.rpc).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
    expect(result.current.conversationId).toBeNull();
    await expect(result.current.send({ body: 'hello' })).rejects.toThrow(/still connecting/);
    expect(amSupabase.rpc).not.toHaveBeenCalled();

    amSupabase.rpc.mockResolvedValue({ data: 'c1', error: null });
    rerender({ ids: ['u2'] });
    expect(result.current.ready).toBe(true);
    await waitFor(() => expect(result.current.conversationId).toBe('c1'));
    expect(amSupabase.rpc).toHaveBeenCalledTimes(1);
  });

  it('keeps the chat usable when eager resolve fails', async () => {
    amSupabase.rpc.mockResolvedValue({ data: null, error: { message: 'You can only message people you studied with' } });
    const { result } = renderHook(() => useAmChat({ memberIds: ['u2'], sessionId: 's1' }));
    await waitFor(() => expect(result.current.error).toBe('You can only message people you studied with'));
    expect(result.current.loading).toBe(false);
    expect(result.current.ready).toBe(true);
    expect(result.current.conversationId).toBeNull();
  });

  it('uses an existing conversationId without calling the rpc', async () => {
    amSupabase.rpc.mockResolvedValue({ data: 'other', error: null });
    const { result } = renderHook(() => useAmChat({ conversationId: 'c1' }));
    expect(result.current.ready).toBe(true);
    expect(result.current.conversationId).toBe('c1');
    await waitFor(() => expect(result.current.messages).toEqual([msg]));
    expect(result.current.loading).toBe(false);
    expect(amMock.loadedIds).toContain('c1');
    expect(amSupabase.rpc).not.toHaveBeenCalled();
  });

  it('echoes a sent message immediately instead of waiting for realtime', async () => {
    const { result } = renderHook(() => useAmChat({ conversationId: 'c1', sessionId: 's1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(() => result.current.send({ body: 'hello' }));

    expect(amSupabase.auth.getUser).toHaveBeenCalledTimes(1);
    expect(amMock.inserted).toMatchObject({ conversation_id: 'c1', sender_id: 'u1', session_id: 's1', body: 'hello' });
    expect(result.current.messages.some((m) => m.id === 'm2' && m.body === 'hello')).toBe(true);
  });
});
