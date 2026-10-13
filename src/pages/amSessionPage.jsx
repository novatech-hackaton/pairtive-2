import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CircleDot, Loader2 } from 'lucide-react';
import { useAmAuth } from '../lib/amAuth.jsx';
import { amSupabase, amFriendlyError } from '../lib/amSupabase.js';
import { amCanScreenShare, amStopLocalStream } from '../lib/amMedia.js';
import { amDailyScreenSupported } from '../lib/amDaily.js';
import { useAmDailyCall } from '../lib/amDailyCall.js';
import { useAmChat } from '../lib/amChat.js';
import { useAmPostgresChanges } from '../lib/amRealtime.js';
import { useAmInterval, useAmIsDesktop } from '../lib/amHooks.js';
import { amCreateNotesSync, amPersistNotes } from '../lib/amNotesSync.js';
import { amSubmitReport } from '../lib/amReporting.js';
import { AmRecorder, amSaveRecording } from '../lib/amRecorder.js';
import { amRecordReducer, amRecordInitial, AM_REC } from '../lib/amRecordConsent.js';
import { amIsMobile } from '../lib/amMedia.js';
import { AmVideoGrid } from '../components/amVideoGrid.jsx';
import { AmControlsBar } from '../components/amControlsBar.jsx';
import { AmChatPanel } from '../components/amChatPanel.jsx';
import { AmNotesPanel } from '../components/amNotesPanel.jsx';
import { AmSidePanel } from '../components/amSidePanel.jsx';
import { AmReportModal } from '../components/amReportModal.jsx';
import { AmRecordConsentModal } from '../components/amRecordConsentModal.jsx';
import { AmLogo } from '../components/amLogo.jsx';
import { amToast } from '../components/amToast.jsx';

export default function AmSessionPage() {
  const { sessionId } = useParams();
  const { user } = useAmAuth();
  const navigate = useNavigate();
  const isDesktop = useAmIsDesktop();

  const [session, setSession] = useState(null);
  const [members, setMembers] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState('chat');
  const [reportTarget, setReportTarget] = useState(null);
  const [notes, setNotes] = useState('');
  const [recording, setRecording] = useState(false);
  const [recState, dispatchRec] = useReducer(amRecordReducer, user.id, amRecordInitial);
  const recorderRef = useRef(null);
  const notesSyncRef = useRef(null);
  const leftRef = useRef(false);
  const recStateRef = useRef(recState);
  recStateRef.current = recState;

  // ---- App-message signaling for recording consent ----
  const onAppMessage = useCallback((data) => {
    if (!data || !data.am) return;
    if (data.am === 'rec-request') dispatchRec({ type: 'request', by: data.by, participants: data.participants });
    else if (data.am === 'rec-respond') dispatchRec({ type: 'respond', from: data.from, accept: data.accept });
    else if (data.am === 'rec-stopped') dispatchRec({ type: 'stopped' });
  }, []);

  const call = useAmDailyCall({ sessionId, selfName: user.user_metadata?.full_name, onAppMessage });

  const chat = useAmChat({ memberIds: members.filter((m) => m.user_id !== user.id).map((m) => m.user_id), sessionId });
  const [unread, setUnread] = useState(0);

  const refreshMembers = useCallback(async () => {
    const { data: m, error: membersError } = await amSupabase.from('session_members').select('user_id, teach_subjects, learn_subjects').eq('session_id', sessionId);
    if (membersError) throw membersError;
    const ids = (m ?? []).map((x) => x.user_id);
    const { data: profs, error: profilesError } = await amSupabase
      .from('profiles')
      .select('id, name, avatar_url')
      .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    if (profilesError) throw profilesError;
    const byId = Object.fromEntries((profs ?? []).map((p) => [p.id, p]));
    setMembers((m ?? []).map((x) => ({ ...x, ...byId[x.user_id] })));
  }, [sessionId]);

  useAmPostgresChanges(
    'session-members-' + sessionId,
    [{ event: 'INSERT', table: 'session_members', filter: 'session_id=eq.' + sessionId }],
    () => refreshMembers().catch((e) => amToast.error(amFriendlyError(e))),
    !!sessionId,
  );
  const expectedMembers = session?.mode === 'peers' ? 3 : 2;
  useAmInterval(
    () => refreshMembers().catch(() => {}),
    session && members.length < expectedMembers ? 4000 : null,
  );

  // Load session + members, mark joined, set up notes sync.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [{ data: s, error: sessionError }, { data: m, error: membersError }] = await Promise.all([
          amSupabase.from('sessions').select('*').eq('id', sessionId).maybeSingle(),
          amSupabase.from('session_members').select('user_id, teach_subjects, learn_subjects').eq('session_id', sessionId),
        ]);
        if (sessionError) throw sessionError;
        if (membersError) throw membersError;
        if (!active) return;
        if (!s) throw new Error('This session is no longer available.');
        setSession(s);
        const ids = (m ?? []).map((x) => x.user_id);
        const { data: profs, error: profilesError } = await amSupabase
          .from('profiles')
          .select('id, name, avatar_url')
          .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
        if (profilesError) throw profilesError;
        const byId = Object.fromEntries((profs ?? []).map((p) => [p.id, p]));
        setMembers((m ?? []).map((x) => ({ ...x, ...byId[x.user_id] })));
        const { error: joinedError } = await amSupabase.rpc('am_mark_joined', { p_session: sessionId });
        if (joinedError) throw joinedError;

        const sync = amCreateNotesSync(sessionId, user.id, { onUpdate: (text) => setNotes(text) });
        notesSyncRef.current = sync;
        const { data: existing, error: notesError } = await amSupabase.from('session_notes').select('content').eq('session_id', sessionId).maybeSingle();
        if (notesError) throw notesError;
        if (existing?.content) sync.seed(existing.content);
        setNotes(sync.getText());
      } catch (e) {
        if (active) setLoadError(amFriendlyError(e));
      }
    })();
    return () => {
      active = false;
      notesSyncRef.current?.destroy();
      notesSyncRef.current = null;
    };
  }, [sessionId, user.id, navigate]);

  // Persist notes snapshot every 5s and on unmount.
  useEffect(() => {
    const t = setInterval(() => {
      const text = notesSyncRef.current?.getText();
      if (text != null) amPersistNotes(sessionId, user.id, text);
    }, 5000);
    return () => {
      clearInterval(t);
      const text = notesSyncRef.current?.getText();
      if (text) amPersistNotes(sessionId, user.id, text);
    };
  }, [sessionId, user.id]);

  // Track unread while the panel is closed or on the notes tab.
  useEffect(() => {
    if (panelOpen && panelTab === 'chat') setUnread(0);
  }, [panelOpen, panelTab, chat.messages.length]);
  useEffect(() => {
    if (!(panelOpen && panelTab === 'chat') && chat.messages.length) {
      const last = chat.messages[chat.messages.length - 1];
      if (last.sender_id !== user.id) setUnread((n) => n + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages.length]);

  const participantUserIds = useMemo(() => call.participants.map((p) => p.userId).filter(Boolean), [call.participants]);
  useEffect(() => {
    dispatchRec({ type: 'participants', ids: call.participants.map((p) => (p.isLocal ? user.id : p.userId)).filter(Boolean) });
  }, [participantUserIds, call.participants, user.id]);

  // ---- Recording lifecycle ----
  async function beginRecording() {
    const tiles = call.participants.map((p) => ({ id: p.id, name: p.name, videoTrack: p.screenOn ? p.screenTrack : p.videoTrack, audioTrack: p.audioTrack }));
    const rec = new AmRecorder();
    rec.start(tiles);
    recorderRef.current = rec;
    setRecording(true);
    if (amIsMobile()) amToast('Recording on mobile can use a lot of memory on long calls.', { icon: '📱' });
  }
  async function stopRecording(saveMine = true) {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    setRecording(false);
    const blob = await rec.stop();
    if (blob && saveMine) {
      const how = await amSaveRecording(blob, rec.mime);
      amToast.success(how === 'shared' ? 'Recording ready to save.' : 'Recording downloaded.');
    }
  }

  // React to consent state transitions.
  useEffect(() => {
    if (recState.phase === AM_REC.RECORDING && !recording) {
      const wantsCopy = recState.selfId === recState.requesterId || recState.wantsCopy[recState.selfId] !== false;
      beginRecording();
      recorderRef.current && (recorderRef.current.wantsCopy = wantsCopy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recState.phase]);

  // 60-min mobile warning.
  useEffect(() => {
    if (!recording || !amIsMobile()) return undefined;
    const t = setTimeout(() => amToast.warning('This recording has reached 60 minutes.'), 60 * 60 * 1000);
    return () => clearTimeout(t);
  }, [recording]);

  function requestRecording() {
    if (recording || recState.phase !== AM_REC.IDLE) {
      if (recording) stopRecordingShared();
      return;
    }
    const ids = call.participants.map((p) => (p.isLocal ? user.id : p.userId)).filter(Boolean);
    if (ids.length < 2) {
      amToast('Wait for someone to join before recording.');
      return;
    }
    dispatchRec({ type: 'request', by: user.id, participants: ids });
    call.broadcast({ am: 'rec-request', by: user.id, participants: ids });
  }
  function respondRecording(accept) {
    dispatchRec({ type: 'respond', from: user.id, accept });
    call.broadcast({ am: 'rec-respond', from: user.id, accept });
  }
  function chooseCopy(wants) {
    dispatchRec({ type: 'copyChoice', from: user.id, wants });
  }
  function stopRecordingShared() {
    const wantsCopy = recorderRef.current?.wantsCopy !== false;
    stopRecording(wantsCopy);
    dispatchRec({ type: 'stopped' });
    call.broadcast({ am: 'rec-stopped' });
  }

  // ---- Leave / rate ----
  const endAndGo = useCallback(
    async (destination) => {
      if (leftRef.current) return;
      leftRef.current = true;
      if (recorderRef.current) await stopRecording(recorderRef.current.wantsCopy !== false);
      const text = notesSyncRef.current?.getText();
      if (text) await amPersistNotes(sessionId, user.id, text);
      let seconds = 0;
      try {
        const { data } = await amSupabase.rpc('am_leave_session', { p_session: sessionId });
        seconds = data ?? 0;
      } catch {
        /* ignore */
      }
      if (destination === 'home') amStopLocalStream();
      if (seconds >= 60) navigate('/rate/' + sessionId + '?next=' + (destination === 'queue' ? '1' : '0'), { replace: true });
      else {
        amStopLocalStream();
        navigate(destination === 'queue' ? '/match' : '/home', { replace: true });
      }
    },
    [sessionId, user.id, navigate],
  );

  async function onReport({ reason, note }) {
    try {
      const target = reportTarget;
      const tile = call.participants.find((p) => p.userId === target.user_id);
      await amSubmitReport({ reportedId: target.user_id, reason, note, sessionId, videoTrack: tile?.videoTrack });
      amToast.success('Report sent. You won\u2019t be matched again.');
      setReportTarget(null);
    } catch (e) {
      amToast.error(e.message);
    }
  }

  const requesterName = members.find((m) => m.user_id === recState.requesterId)?.name;

  if (loadError || call.error) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div>
          <AmLogo className="mb-6 justify-center" />
          <p className="text-lg font-semibold text-white">We couldn\u2019t connect you to the call</p>
          <p className="mt-1 text-slate-400">{loadError || call.error}</p>
          <button onClick={() => endAndGo('home')} className="mt-6 rounded-xl bg-brand px-5 py-2.5 font-medium text-white">Back to home</button>
        </div>
      </div>
    );
  }

  const chatPanel = <AmChatPanel messages={chat.messages} loading={chat.loading} members={members} selfId={user.id} onSend={chat.send} ready={chat.ready} error={chat.error} />;
  const notesPanel = (
    <AmNotesPanel value={notes} editorCount={call.participants.length} onChange={(v) => { setNotes(v); notesSyncRef.current?.setFromInput(v); }} />
  );

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden bg-ink-950 p-3 sm:p-4">
      <header className="mb-3 flex items-center justify-between">
        <AmLogo withText={false} />
        <div className="flex items-center gap-2">
          {recording ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/15 px-3 py-1 text-xs font-semibold text-rose-200 ring-1 ring-rose-400/40">
              <CircleDot className="size-3.5 animate-rec" aria-hidden /> Recording
            </span>
          ) : null}
          <span className="rounded-full bg-white/8 px-3 py-1 text-xs font-medium text-slate-300">
            {session?.mode === 'peers' ? 'Study Peers' : 'Study Buddy'}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 gap-3">
        <main className="min-h-0 min-w-0 flex-1">
          {call.joined ? (
            <AmVideoGrid participants={call.participants} onReport={(p) => setReportTarget(members.find((m) => m.user_id === p.userId) || { user_id: p.userId, name: p.name })} />
          ) : (
            <div className="grid h-full place-items-center rounded-2xl bg-ink-800 ring-1 ring-white/10">
              <span className="inline-flex items-center gap-3 text-slate-300">
                <Loader2 className="size-5 animate-spin" aria-hidden /> Connecting you to the room…
              </span>
            </div>
          )}
        </main>
        {isDesktop ? (
          <AmSidePanel isDesktop open={panelOpen} tab={panelTab} onTab={setPanelTab} onClose={() => setPanelOpen(false)} chat={chatPanel} notes={notesPanel} unread={unread} />
        ) : null}
      </div>

      <footer className="mt-3 flex max-w-full justify-center">
        <AmControlsBar
          micOn={call.micOn}
          camOn={call.camOn}
          screenOn={call.screenOn}
          recording={recording}
          canScreenShare={amCanScreenShare() && amDailyScreenSupported()}
          unread={unread}
          mode={session?.mode}
          onToggleMic={call.toggleMic}
          onToggleCam={call.toggleCam}
          onToggleScreen={call.toggleScreen}
          onToggleChat={() => { setPanelTab('chat'); setPanelOpen((o) => (panelTab === 'chat' ? !o : true)); setUnread(0); }}
          onToggleNotes={() => { setPanelTab('notes'); setPanelOpen((o) => (panelTab === 'notes' ? !o : true)); }}
          onRecord={requestRecording}
          onNext={() => endAndGo('queue')}
          onStop={() => endAndGo('home')}
        />
      </footer>

      {!isDesktop ? (
        <AmSidePanel isDesktop={false} open={panelOpen} tab={panelTab} onTab={setPanelTab} onClose={() => setPanelOpen(false)} chat={chatPanel} notes={notesPanel} unread={unread} />
      ) : null}

      <AmReportModal open={!!reportTarget} onClose={() => setReportTarget(null)} reportedName={reportTarget?.name} onSubmit={onReport} />
      <AmRecordConsentModal state={recState} requesterName={requesterName} onRespond={respondRecording} onCopyChoice={chooseCopy} onCancel={stopRecordingShared} />
    </div>
  );
}
