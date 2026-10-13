import { useEffect, useRef, useState } from 'react';
import { FileText, ImageIcon, Paperclip, Send, X } from 'lucide-react';
import { amAttachmentUrl } from '../lib/amChat.js';
import { amIsImageType, amFormatBytes, amValidateAttachment } from '../../shared/amAttachments.js';
import { AmAvatar } from './amAvatar.jsx';
import { AmButton, AmIconButton } from './amButton.jsx';
import { AmEmptyState } from './amEmptyState.jsx';
import { amToast } from './amToast.jsx';

function AmAttachment({ msg }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let active = true;
    amAttachmentUrl(msg.attachment_path).then((u) => active && setUrl(u));
    return () => { active = false; };
  }, [msg.attachment_path]);
  const isImage = amIsImageType(msg.attachment_type);
  if (isImage) {
    return url ? (
      <a href={url} target="_blank" rel="noreferrer" className="mt-1 block overflow-hidden rounded-xl">
        <img src={url} alt={msg.attachment_name} className="max-h-56 w-auto rounded-xl" loading="lazy" />
      </a>
    ) : <div className="mt-1 h-28 w-40 animate-pulse rounded-xl bg-white/10" />;
  }
  return (
    <a href={url ?? '#'} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-2.5 rounded-xl bg-white/8 p-2.5 ring-1 ring-white/10 hover:bg-white/12">
      <FileText className="size-5 text-brand-cyan" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-white">{msg.attachment_name}</span>
        <span className="text-xs text-slate-400">{amFormatBytes(msg.attachment_size || 0)}</span>
      </span>
    </a>
  );
}

export function AmChatPanel({ messages, loading, members, selfId, onSend, ready = true, error = null }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(false);
  // Sync guard: Enter + click in the same tick can't double-send.
  const sendingRef = useRef(false);
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const nameById = Object.fromEntries((members ?? []).map((m) => [m.id, m]));

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function submit(e) {
    e.preventDefault();
    if (!ready || sendingRef.current || (!text.trim() && !file)) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await onSend({ body: text, file });
      setText('');
      setFile(null);
    } catch (err) {
      amToast.error(err.message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }
  const canSend = ready && !sending && (!!text.trim() || !!file);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
        {loading ? (
          <p className="py-8 text-center text-sm text-slate-500">Loading messages…</p>
        ) : messages.length === 0 ? (
          <AmEmptyState icon={Send} title="Say hi" description="Messages you send here are saved so you can keep chatting later." />
        ) : (
          messages.map((m, i) => {
            const mine = m.sender_id === selfId;
            const prev = messages[i - 1];
            const showHead = !mine && (!prev || prev.sender_id !== m.sender_id);
            const who = nameById[m.sender_id];
            return (
              <div key={m.id} className={'flex items-end gap-2 ' + (mine ? 'justify-end' : '')}>
                {!mine ? <div className="w-7">{showHead ? <AmAvatar name={who?.name ?? ''} src={who?.avatar_url} size="xs" /> : null}</div> : null}
                <div className={'max-w-[78%] ' + (mine ? 'items-end' : '')}>
                  {showHead ? <p className="mb-0.5 ml-1 text-xs text-slate-400">{who?.name}</p> : null}
                  <div className={'rounded-2xl px-3.5 py-2 text-sm ' + (mine ? 'bg-brand text-white' : 'bg-white/8 text-slate-100')}>
                    {m.body ? <p className="break-words whitespace-pre-wrap">{m.body}</p> : null}
                    {m.attachment_path ? <AmAttachment msg={m} /> : null}
                  </div>
                  <p className={'mt-0.5 text-[0.65rem] text-slate-500 ' + (mine ? 'text-right' : 'ml-1')}>{new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
                </div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>

      {file ? (
        <div className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-xl bg-white/8 p-2 text-sm text-slate-200">
          {amIsImageType(file.type) ? <ImageIcon className="size-4 text-brand-cyan" aria-hidden /> : <FileText className="size-4 text-brand-cyan" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <AmIconButton icon={X} label="Remove attachment" tone="ghost" size="sm" onClick={() => setFile(null)} />
        </div>
      ) : null}

      {error ? <p className="shrink-0 px-4 pb-1 text-xs text-rose-300" role="status">{error}</p> : null}
      <form onSubmit={submit} className="flex shrink-0 items-center gap-2 border-t border-white/8 p-3">
        <input
          ref={fileRef}
          type="file"
          className="am-sr-only"
          aria-label="Attach a file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const err = amValidateAttachment(f);
            if (err) amToast.error(err);
            else setFile(f);
            e.target.value = '';
          }}
        />
        <AmIconButton icon={Paperclip} label="Attach image or file" tone="ghost" size="sm" disabled={!ready} onClick={() => fileRef.current?.click()} />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ready ? 'Message' : 'Connecting chat…'}
          aria-label="Message"
          disabled={!ready}
          className="h-11 min-w-0 flex-1 rounded-full bg-white/[0.06] px-4 text-sm text-white ring-1 ring-white/10 focus:ring-2 focus:ring-brand-violet focus:outline-none disabled:opacity-60"
        />
        <AmIconButton icon={Send} label="Send message" tone="brand" size="md" type="submit" disabled={!canSend} />
      </form>
    </div>
  );
}
