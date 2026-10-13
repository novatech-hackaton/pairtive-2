import { useEffect, useRef } from 'react';
import { Flag, MicOff, MonitorUp, VideoOff } from 'lucide-react';
import { AmAvatar } from './amAvatar.jsx';
import { AmIconButton } from './amButton.jsx';

function AmTile({ participant, isLocal, onReport }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const { videoTrack, audioTrack, screenTrack, name, camOn, micOn, screenOn } = participant;
  const activeVideo = screenOn ? screenTrack : videoTrack;

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = activeVideo ? new MediaStream([activeVideo]) : null;
  }, [activeVideo]);
  useEffect(() => {
    if (audioRef.current) audioRef.current.srcObject = audioTrack && !isLocal ? new MediaStream([audioTrack]) : null;
  }, [audioTrack, isLocal]);

  return (
    <div className="group relative overflow-hidden rounded-2xl bg-ink-800 ring-1 ring-white/10">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className={(isLocal && !screenOn ? 'am-mirror ' : '') + 'size-full object-cover ' + (activeVideo ? '' : 'invisible')}
      />
      {!isLocal ? <audio ref={audioRef} autoPlay /> : null}
      {activeVideo ? null : (
        <div className="absolute inset-0 grid place-items-center">
          <AmAvatar name={name} size="lg" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-linear-to-t from-ink-950/80 to-transparent p-2.5">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-950/60 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
          {screenOn ? <MonitorUp className="size-3.5 text-brand-cyan" aria-hidden /> : null}
          {name}{isLocal ? ' (you)' : ''}
          {!micOn ? <MicOff className="size-3.5 text-rose-300" aria-hidden /> : null}
          {!camOn && !screenOn ? <VideoOff className="size-3.5 text-slate-400" aria-hidden /> : null}
        </span>
        {!isLocal && onReport ? (
          <span className="opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
            <AmIconButton icon={Flag} label={'Report ' + name} tone="ghost" size="sm" tooltip onClick={() => onReport(participant)} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

const AM_GRID = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-2',
  4: 'grid-cols-2',
  5: 'grid-cols-2 sm:grid-cols-3',
};

export function AmVideoGrid({ participants, onReport }) {
  const sharer = participants.find((p) => p.screenOn && !p.isLocal) || participants.find((p) => p.screenOn);
  if (sharer) {
    const others = participants.filter((p) => p.id !== sharer.id);
    return (
      <div className="flex h-full flex-col gap-3 lg:flex-row">
        <div className="min-h-0 flex-1">
          <AmTile participant={sharer} isLocal={sharer.isLocal} onReport={onReport} />
        </div>
        <div className="flex gap-3 overflow-x-auto lg:w-56 lg:flex-col lg:overflow-y-auto">
          {others.map((p) => (
            <div key={p.id} className="aspect-video w-40 shrink-0 lg:w-full">
              <AmTile participant={p} isLocal={p.isLocal} onReport={onReport} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  const n = Math.min(participants.length, 5) || 1;
  return (
    <div className={'grid h-full auto-rows-fr gap-3 ' + (AM_GRID[n] || 'grid-cols-2')}>
      {participants.map((p) => (
        <AmTile key={p.id} participant={p} isLocal={p.isLocal} onReport={onReport} />
      ))}
    </div>
  );
}
