import { useCallback, useEffect, useRef, useState } from 'react';
import { amSupabase } from './amSupabase.js';
import { amApi } from './amApi.js';
import { useAmInterval, useAmLatest } from './amHooks.js';
import { useAmPostgresChanges } from './amRealtime.js';

export const AM_HEARTBEAT_MS = 10_000;
export const AM_POLL_MS = 2_000;

/**
 * Drives the whole matching lifecycle for one user:
 *   idle -> searching (join queue, heartbeat, poll matcher) -> preview (proposal) -> starting (session).
 * The matcher runs server-side; the client polls amMatch and also listens via Realtime.
 */
export function useAmQueue(userId) {
  const [phase, setPhase] = useState('idle'); // idle | searching | preview | starting | error
  const [proposal, setProposal] = useState(null);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState('');
  const [errorReason, setErrorReason] = useState(null); // e.g. 'diagnostic-required' from amMatch's 403
  const [sessionId, setSessionId] = useState(null);
  const [myResponse, setMyResponse] = useState(null);
  const phaseRef = useAmLatest(phase);
  const busyRef = useRef(false);
  // Set once amStartSession is in flight (from respond or startFromProposal) so it runs only once.
  const startingRef = useRef(false);

  const tick = useCallback(async () => {
    if (busyRef.current || phaseRef.current === 'idle' || phaseRef.current === 'starting') return;
    busyRef.current = true;
    try {
      const res = await amApi('amMatch');
      setErrorReason(null);
      setWaiting(res.waiting ?? 0);
      if (res.status === 'proposed' && res.proposal) {
        setProposal(res.proposal);
        setMyResponse(res.proposal.members.find((m) => m.user_id === userId)?.accepted ?? null);
        if (res.proposal.status === 'pending') setPhase('preview');
      } else if (res.status === 'in_session') {
        // Everyone accepted (the last accepter's RPC moved all queue rows to in_session).
        // Surfacing the accepted proposal triggers startFromProposal below. Never drop to idle here.
        if (res.proposal) {
          setProposal(res.proposal);
          setPhase((p) => (p === 'starting' ? p : 'preview'));
        }
      } else if (res.status === 'waiting') {
        setProposal(null);
        setMyResponse(null);
        setPhase('searching');
      } else if (res.status === 'idle') {
        setPhase((p) => (p === 'starting' ? p : 'idle'));
      }
    } catch (e) {
      if (e.status === 403) {
        setError(e.message);
        setErrorReason(e.reason ?? null);
      } else setError(e.message || 'Could not reach the matching service. Please try again.');
      setPhase('error');
    } finally {
      busyRef.current = false;
    }
  }, [userId, phaseRef]);

  useAmInterval(() => amSupabase.rpc('am_heartbeat'), phase === 'searching' || phase === 'preview' ? AM_HEARTBEAT_MS : null);
  useAmInterval(tick, phase === 'searching' || phase === 'preview' ? AM_POLL_MS : null);

  useAmPostgresChanges(
    'queue',
    [{ event: '*', table: 'match_queue', filter: `user_id=eq.${userId}` }],
    () => tick(),
    phase === 'searching' || phase === 'preview',
  );

  const start = useCallback(
    async (mode, sameSchoolOnly) => {
      setError('');
      setErrorReason(null);
      setProposal(null);
      setMyResponse(null);
      startingRef.current = false;
      try {
        const { error: err } = await amSupabase.rpc('am_join_queue', { p_mode: mode, p_same_school: sameSchoolOnly });
        if (err) throw err;
        setPhase('searching');
        tick();
      } catch (e) {
        setError(e.message);
        setErrorReason(e.reason ?? null);
        setPhase('error');
      }
    },
    [tick],
  );

  const respond = useCallback(
    async (accept) => {
      if (!proposal) return;
      setMyResponse(accept);
      try {
        const { data: status, error: err } = await amSupabase.rpc('am_respond_proposal', { p_proposal: proposal.id, p_accept: accept });
        if (err) throw err;
        if (status === 'accepted') {
          setPhase('starting');
          if (startingRef.current) return;
          startingRef.current = true;
          const { sessionId: sid } = await amApi('amStartSession', { proposalId: proposal.id });
          setSessionId(sid);
        } else if (status === 'declined' || status === 'expired') {
          setProposal(null);
          setMyResponse(null);
          setPhase('searching');
          tick();
        }
      } catch (e) {
        startingRef.current = false;
        setMyResponse(null);
        setError(e.message || 'Could not start the session. Please try again.');
        setPhase('error');
      }
    },
    [proposal, tick],
  );

  const startFromProposal = useCallback(async () => {
    if (!proposal || sessionId || startingRef.current) return;
    startingRef.current = true;
    setPhase('starting');
    try {
      const { sessionId: sid } = await amApi('amStartSession', { proposalId: proposal.id });
      setSessionId(sid);
    } catch (e) {
      startingRef.current = false;
      setError(e.message || 'Could not start the session. Please try again.');
      setPhase('error');
    }
  }, [proposal, sessionId]);

  useEffect(() => {
    if (proposal?.status === 'accepted') startFromProposal();
  }, [proposal?.status, startFromProposal]);

  const leave = useCallback(async () => {
    setPhase('idle');
    setProposal(null);
    setMyResponse(null);
    setErrorReason(null);
    startingRef.current = false;
    try {
      await amSupabase.rpc('am_leave_queue');
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    const handler = () => {
      if (phaseRef.current === 'searching' || phaseRef.current === 'preview') amSupabase.rpc('am_leave_queue');
    };
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, [phaseRef]);

  return { phase, proposal, waiting, error, errorReason, sessionId, myResponse, start, respond, leave };
}
