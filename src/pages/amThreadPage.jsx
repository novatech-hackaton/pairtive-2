import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, NotebookPen, PhoneCall } from 'lucide-react';
import { useAmAuth } from '../lib/amAuth.jsx';
import { amSupabase } from '../lib/amSupabase.js';
import { amApi } from '../lib/amApi.js';
import { useAmChat } from '../lib/amChat.js';
import { useAmPostgresChanges } from '../lib/amRealtime.js';
import { amDateTime } from '../lib/amFormat.js';
import { AmAvatar, AmAvatarStack } from '../components/amAvatar.jsx';
import { AmChatPanel } from '../components/amChatPanel.jsx';
import { AmButton, AmIconButton } from '../components/amButton.jsx';
import { AmModal } from '../components/amModal.jsx';
import { AmFullScreenLoader } from '../components/amLogo.jsx';
import { amToast } from '../components/amToast.jsx';

export default function AmThreadPage() {
  const { conversationId } = useParams();
  const { user } = useAmAuth();
  const navigate = useNavigate();
  const [members, setMembers] = useState(null);
  const [notes, setNotes] = useState([]);
  const [showNotes, setShowNotes] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const chat = useAmChat({ conversationId });

  useEffect(() => {
    (async () => {
      const { data: mem } = await amSupabase.from('conversation_members').select('user_id').eq('conversation_id', conversationId);
      const ids = (mem ?? []).map((m) => m.user_id);
      if (!ids.length) { navigate('/messages', { replace: true }); return; }
      const { data: profs } = await amSupabase.from('profiles').select('id, name, avatar_url').in('id', ids);
      setMembers(profs ?? []);
      const { data: n } = await amSupabase.rpc('am_thread_notes', { p_conversation: conversationId });
      setNotes(n ?? []);
    })();
  }, [conversationId, navigate]);

  // Reconnect: when the other side accepts, jump into the session.
  const onInviteChange = useCallback(async (payload) => {
    const inv = payload.new;
    if (inv?.status === 'accepted' && inv.from_user === user.id) {
      try {
        const { sessionId } = await amApi('amStartSession', { inviteId: inv.id });
        navigate('/session/' + sessionId);
      } catch (e) { amToast.error(e.message); }
    }
  }, [user.id, navigate]);
  useAmPostgresChanges('invite-' + conversationId, [{ event: 'UPDATE', table: 'session_invites', filter: 'conversation_id=eq.' + conversationId }], onInviteChange, true);

  async function reconnect() {
    setReconnecting(true);
    try {
      const { error } = await amSupabase.rpc('am_create_invite', { p_conversation: conversationId });
      if (error) throw error;
      amToast('Invite sent. Waiting for them to join…');
    } catch (e) {
      amToast.error(e.message);
    } finally {
      setTimeout(() => setReconnecting(false), 4000);
    }
  }

  if (!members) return <AmFullScreenLoader label="Opening chat…" />;
  const others = members.filter((m) => m.id !== user.id);
  const title = others.map((m) => m.name).join(', ');

  return (
    <div className="mx-auto flex h-full min-h-0 min-w-0 max-w-2xl flex-col">
      <header className="mb-3 flex items-center gap-3">
        <AmIconButton icon={ArrowLeft} label="Back to messages" tone="ghost" size="sm" tooltip={false} onClick={() => navigate('/messages')} />
        {others.length > 1 ? <AmAvatarStack people={others} /> : <AmAvatar name={others[0]?.name ?? ''} src={others[0]?.avatar_url} />}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-white">{title}</p>
          <p className="text-xs text-slate-400">{others.length > 1 ? others.length + ' study peers' : 'Study buddy'}</p>
        </div>
        {notes.length ? <AmIconButton icon={NotebookPen} label="Session notes" tone="ghost" size="sm" onClick={() => setShowNotes(true)} /> : null}
        <AmButton size="sm" icon={PhoneCall} loading={reconnecting} onClick={reconnect}>Reconnect</AmButton>
      </header>

      <div className="glass min-h-0 min-w-0 flex-1 overflow-hidden rounded-3xl">
        <AmChatPanel messages={chat.messages} loading={chat.loading} members={members} selfId={user.id} onSend={chat.send} ready={chat.ready} error={chat.error} />
      </div>

      <AmModal open={showNotes} onClose={() => setShowNotes(false)} title="Session notes" size="lg" icon={NotebookPen}>
        <div className="space-y-4">
          {notes.map((n) => (
            <div key={n.session_id}>
              <p className="mb-1 text-xs text-slate-500">{amDateTime(n.started_at)}</p>
              <pre className="rounded-2xl bg-white/[0.04] p-3 text-sm whitespace-pre-wrap text-slate-200 ring-1 ring-white/10">{n.content}</pre>
            </div>
          ))}
        </div>
      </AmModal>
    </div>
  );
}
