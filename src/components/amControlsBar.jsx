import { CircleDot, MessageCircle, Mic, MicOff, MonitorUp, MonitorX, NotebookPen, PhoneOff, SkipForward, Video, VideoOff } from 'lucide-react';
import { AmButton, AmIconButton } from './amButton.jsx';

/** The bottom control bar for a live session. Screen-share hidden when unsupported. */
export function AmControlsBar({
  micOn, camOn, screenOn, recording, canScreenShare, unread, mode,
  onToggleMic, onToggleCam, onToggleScreen, onToggleChat, onToggleNotes, onRecord, onNext, onStop,
}) {
  return (
    <div className="glass-strong flex max-w-full min-w-0 items-center justify-center gap-1 rounded-full px-2 py-2 shadow-glow sm:gap-3 sm:px-3 sm:py-2.5">
      <AmIconButton className="max-sm:size-9" icon={micOn ? Mic : MicOff} label={micOn ? 'Mute' : 'Unmute'} active={micOn} pressed={!micOn} onClick={onToggleMic} />
      <AmIconButton className="max-sm:size-9" icon={camOn ? Video : VideoOff} label={camOn ? 'Turn camera off' : 'Turn camera on'} active={camOn} pressed={!camOn} onClick={onToggleCam} />
      {canScreenShare ? (
        <AmIconButton className="max-sm:size-9" icon={screenOn ? MonitorX : MonitorUp} label={screenOn ? 'Stop sharing' : 'Share screen'} tone={screenOn ? 'brand' : 'default'} onClick={onToggleScreen} />
      ) : null}
      <AmIconButton icon={CircleDot} label={recording ? 'Recording in progress' : 'Record session'} tone={recording ? 'rec' : 'default'} onClick={onRecord} className={'max-sm:size-9 ' + (recording ? 'animate-rec' : '')} />
      <span className="hidden sm:block sm:h-8 sm:w-px sm:bg-white/10" aria-hidden />
      <AmIconButton className="max-sm:size-9" icon={MessageCircle} label="Chat" badge={unread > 0 ? (unread > 9 ? '9+' : unread) : undefined} onClick={onToggleChat} />
      <AmIconButton className="max-sm:size-9" icon={NotebookPen} label="Shared notes" onClick={onToggleNotes} />
      <span className="hidden sm:block sm:h-8 sm:w-px sm:bg-white/10" aria-hidden />
      <AmButton variant="secondary" icon={SkipForward} onClick={onNext} className="hidden sm:inline-flex">
        {mode === 'peers' ? 'Leave' : 'Next'}
      </AmButton>
      <AmIconButton icon={SkipForward} label={mode === 'peers' ? 'Leave group' : 'Next match'} onClick={onNext} className="max-sm:size-9 sm:hidden" />
      <AmIconButton icon={PhoneOff} label="Stop and finish" tone="danger" onClick={onStop} className="max-sm:size-9" />
    </div>
  );
}
