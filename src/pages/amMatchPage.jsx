import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, Sparkles, Users, UserRound, X } from 'lucide-react';
import { useAmAuth } from '../lib/amAuth.jsx';
import { amSupabase } from '../lib/amSupabase.js';
import { amPeekLocalStream, amStopLocalStream } from '../lib/amMedia.js';
import { useAmQueue } from '../lib/amQueue.js';
import { useAmLatest, useAmNow } from '../lib/amHooks.js';
import { AmButton } from '../components/amButton.jsx';
import { AmCard } from '../components/amCard.jsx';
import { AmCameraPreview } from '../components/amCameraPreview.jsx';
import { AmRulesCard } from '../components/amRulesCard.jsx';
import { AmHowMatchingWorks } from '../components/amHowMatchingWorks.jsx';
import { AmRadar } from '../components/amRadar.jsx';
import { AmPreviewCard } from '../components/amPreviewCard.jsx';
import { AmSwitch } from '../components/amField.jsx';
import { amToast } from '../components/amToast.jsx';
import { AM_MATCH_CONFIG, amJoinNames } from '../../shared/amMatchScore.js';

const AM_MODES = [
  { id: 'buddy', title: 'Study Buddy', line: '1-on-1', icon: UserRound, blurb: 'A focused two-way swap with one partner.' },
  { id: 'peers', title: 'Study Peers', line: '3 to 5', icon: Users, blurb: 'A small group where everyone teaches and learns.' },
];

// Keeps keyboard-focused / scrolled-to actions clear of the fixed mobile tab bar (main has pb-28).
const AM_CLEAR_TABBAR = 'scroll-mb-32 md:scroll-mb-8';

export default function AmMatchPage() {
  const { user, profile, refreshProfile } = useAmAuth();
  const navigate = useNavigate();
  const q = useAmQueue(user.id);
  const [mode, setMode] = useState('buddy');
  const [sameSchool, setSameSchool] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const rulesAccepted = !!profile.rules_accepted_at;
  const searchStart = useRef(Date.now());
  const now = useAmNow(1000);

  // Latest phase for the unmount cleanup (a plain closure would only see the first render's 'idle').
  const phaseRef = useAmLatest(q.phase);
  useEffect(() => {
    return () => {
      // Heading into the session: keep the camera stream, and let the session page's am_mark_joined clear the queue row.
      if (phaseRef.current === 'starting') return;
      amSupabase.rpc('am_leave_queue');
      amStopLocalStream();
    };
  }, [phaseRef]);

  useEffect(() => {
    if (q.phase === 'starting' && q.sessionId) {
      navigate('/session/' + q.sessionId, { replace: true });
    }
  }, [q.phase, q.sessionId, navigate]);

  // amMatch rejects users with zero mastery records; send them to take the diagnostic.
  useEffect(() => {
    if (q.errorReason === 'diagnostic-required') navigate('/diagnostic', { replace: true });
  }, [q.errorReason, navigate]);

  useEffect(() => {
    if (q.phase === 'searching') searchStart.current = Date.now();
  }, [q.phase]);

  async function onFind() {
    if (!rulesAccepted && !agreed) {
      amToast.error('Please agree to the community rules first.');
      return;
    }
    if (!rulesAccepted) {
      await amSupabase.from('profiles').update({ rules_accepted_at: new Date().toISOString() }).eq('id', user.id);
      await refreshProfile();
    }
    q.start(mode, sameSchool);
  }

  // One-time "you're matched" toast per proposal, once it is accepted by everyone.
  const toastedProposal = useRef(null);
  const proposalId = q.proposal?.id ?? null;
  const everyoneAccepted =
    !!q.proposal &&
    (q.phase === 'starting' || q.proposal.status === 'accepted' || (q.proposal.members ?? []).every((m) => m.accepted === true));
  useEffect(() => {
    if (!proposalId || !everyoneAccepted || toastedProposal.current === proposalId) return;
    toastedProposal.current = proposalId;
    amToast.success("You're matched! Joining the session…");
  }, [proposalId, everyoneAccepted]);

  const previewMembers = q.proposal?.members ?? [];
  const matchedNames = amJoinNames(previewMembers.filter((m) => m.user_id !== user.id).map((m) => m.profile?.name ?? 'Student'));
  const expiresAt = q.proposal ? new Date(q.proposal.expires_at).getTime() : 0;
  const secondsLeft = Math.max(0, (expiresAt - now) / 1000);
  const searchSeconds = Math.floor((now - searchStart.current) / 1000);
  const idle = q.phase === 'idle' || q.phase === 'error';

  return (
    <div className="mx-auto w-full max-w-3xl lg:max-w-6xl">
      <div className="mb-5 flex items-center gap-2 sm:gap-3">
        <AmButton variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate('/home')} className="min-h-11 shrink-0">
          Home
        </AmButton>
        <h1 className="min-w-0 truncate text-xl font-bold text-white sm:text-2xl">Find a match</h1>
      </div>

      {/* Mobile: full-width camera card in normal flow above the content. lg+: camera left (sticky), content right. */}
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-start lg:gap-6">
        <div className="min-w-0 lg:sticky lg:top-24">
          <AmCameraPreview name={profile.name} aspect={idle ? 'aspect-[4/3] sm:aspect-video lg:aspect-[4/3]' : 'aspect-video lg:aspect-[4/3]'} />
        </div>

        <div className="min-w-0">
          <AnimatePresence mode="wait">
            {q.phase === 'preview' && q.proposal ? (
              <AmPreviewCard
                key="preview"
                me={profile}
                myId={user.id}
                members={previewMembers}
                mode={q.proposal.mode}
                secondsLeft={secondsLeft}
                total={15}
                myResponse={q.myResponse}
                onAccept={() => q.respond(true)}
                onNext={() => q.respond(false)}
              />
            ) : q.phase === 'searching' || q.phase === 'starting' ? (
              <motion.div key="searching" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {/* overflow-hidden: the radar pulses scale past their box and would otherwise cause horizontal scroll on phones. */}
                <AmCard className="flex flex-col items-center overflow-hidden px-4 text-center sm:px-6">
                  <AmRadar name={profile.name} avatarUrl={profile.avatar_url} subjects={[...profile.weak_subjects, ...profile.strong_subjects]} />
                  <h2 className="mt-6 text-lg font-semibold text-balance text-white sm:text-xl" aria-live="polite">
                    {q.phase === 'starting'
                      ? matchedNames
                        ? 'Matched with ' + matchedNames + '! Starting your session…'
                        : 'Starting your session…'
                      : mode === 'peers' ? 'Gathering your study group…' : 'Looking for your match…'}
                  </h2>
                  <p className="mt-1 max-w-full text-sm text-balance break-words text-slate-400" aria-live="polite">
                    {q.waiting > 1 ? q.waiting + ' students searching right now' : 'Hang tight, this usually takes a few seconds'} · {searchSeconds}s
                  </p>
                  {searchSeconds >= AM_MATCH_CONFIG.relaxAfterMs / 1000 && mode === 'buddy' ? (
                    <p className="mt-2 text-xs text-balance text-brand-cyan">Widening the search to one-way matches too…</p>
                  ) : null}
                  <AmButton variant="secondary" icon={X} className={'mt-6 w-full sm:w-auto sm:min-w-40 ' + AM_CLEAR_TABBAR} onClick={() => q.leave()}>
                    Cancel
                  </AmButton>
                </AmCard>
              </motion.div>
            ) : (
              <motion.div key="idle" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-5">
                <AmCard>
                  <h2 className="mb-3 text-lg font-semibold text-white">How do you want to study?</h2>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Match mode">
                    {AM_MODES.map((m) => {
                      const on = mode === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => setMode(m.id)}
                          className={'w-full min-w-0 rounded-3xl p-4 text-left ring-1 transition sm:p-5 ' + (on ? 'bg-white/10 ring-2 ring-brand-violet shadow-glow' : 'bg-white/[0.03] ring-white/10 hover:bg-white/[0.06]')}
                        >
                          <div className="flex items-center gap-3">
                            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-brand text-white shadow-glow">
                              <m.icon className="size-5" aria-hidden />
                            </span>
                            <div className="min-w-0">
                              <p className="font-semibold text-white">{m.title}</p>
                              <p className="text-xs text-slate-400">{m.line}</p>
                            </div>
                          </div>
                          <p className="mt-3 text-sm text-slate-300">{m.blurb}</p>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-4 border-t border-white/8 pt-4">
                    <AmSwitch
                      checked={sameSchool}
                      onChange={setSameSchool}
                      label="Same school only"
                      description={'Only match within ' + (profile.school || 'your school') + '.'}
                    />
                  </div>
                </AmCard>

                <AmButton size="xl" icon={Sparkles} className={'w-full ' + AM_CLEAR_TABBAR} onClick={onFind} disabled={!rulesAccepted && !agreed}>
                  Find match
                </AmButton>

                <AmRulesCard accepted={rulesAccepted} agreed={agreed} onAgreeChange={setAgreed} />
                <AmHowMatchingWorks />

                {q.phase === 'error' && q.error ? (
                  <p className="rounded-2xl bg-rose-500/10 p-3 text-center text-sm text-rose-200 ring-1 ring-rose-400/30" role="alert">
                    {q.error}
                  </p>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
