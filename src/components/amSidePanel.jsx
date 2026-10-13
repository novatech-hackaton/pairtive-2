import { MessageCircle, NotebookPen } from 'lucide-react';
import { AmSheet } from './amSheet.jsx';

/** Chat + Notes container. Docked panel on desktop, bottom sheet on mobile. */
export function AmSidePanel({ isDesktop, open, tab, onTab, onClose, chat, notes, unread }) {
  const Tabs = (
    <div className="flex gap-1 p-2" role="tablist" aria-label="Session panel">
      <button
        role="tab"
        aria-selected={tab === 'chat'}
        onClick={() => onTab('chat')}
        className={'flex flex-1 items-center justify-center gap-2 rounded-xl py-2 text-sm font-medium transition ' + (tab === 'chat' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white')}
      >
        <MessageCircle className="size-4" aria-hidden /> Chat
        {unread > 0 ? <span className="grid min-w-5 place-items-center rounded-full bg-brand-cyan px-1 text-[0.65rem] font-bold text-ink-950">{unread}</span> : null}
      </button>
      <button
        role="tab"
        aria-selected={tab === 'notes'}
        onClick={() => onTab('notes')}
        className={'flex flex-1 items-center justify-center gap-2 rounded-xl py-2 text-sm font-medium transition ' + (tab === 'notes' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white')}
      >
        <NotebookPen className="size-4" aria-hidden /> Notes
      </button>
    </div>
  );

  const Body = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {Tabs}
      <div className="min-h-0 flex-1 overflow-hidden" role="tabpanel">
        {tab === 'chat' ? chat : notes}
      </div>
    </div>
  );

  if (isDesktop) {
    return open ? <aside className="glass-strong flex w-[22rem] shrink-0 flex-col overflow-hidden rounded-3xl">{Body}</aside> : null;
  }
  return (
    <AmSheet open={open} onClose={onClose} title={tab === 'chat' ? 'Chat' : 'Shared notes'}>
      {Body}
    </AmSheet>
  );
}
