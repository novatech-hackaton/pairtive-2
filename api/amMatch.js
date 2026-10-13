// POST /api/amMatch - heartbeat + run the AI matcher + return the caller's match state.
import { AM_MATCH_CONFIG, amBuildBlockSet, amCreateCooldownIndex, amNormalizeUser } from '../shared/amMatchScore.js';
import { amPlanMatches } from '../shared/amGroupBuilder.js';
import { AmHttpError, amAdmin, amDbError, amHandler, amRequireUser } from '../server/amServer.js';

const PROFILE_FIELDS =
  'id, name, avatar_url, school, languages, weak_subjects, strong_subjects, subjects_source, rating_avg, rating_count, success_count, sessions_count, status, suspended_until';

/**
 * Diagnostic gate (Req 3.3). Joining happens through the `am_join_queue` RPC, so the first
 * poll is where a user without Mastery_Records is caught: drop their queue row so no other
 * matcher run can plan them, then tell the client to send them to the diagnostic.
 */
async function amRequireDiagnostic(admin, userId) {
  const { count, error } = await admin
    .from('student_topic_mastery')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  amDbError(error);
  if (count) return;
  const { error: delError } = await admin.from('match_queue').delete().eq('user_id', userId);
  amDbError(delError);
  throw new AmHttpError(403, 'Take the diagnostic before matching.', { reason: 'diagnostic-required' });
}

async function amRunMatcher(admin, mode) {
  const freshSince = new Date(Date.now() - AM_MATCH_CONFIG.staleMs).toISOString();
  const { data: queue, error } = await admin
    .from('match_queue')
    .select('*')
    .eq('mode', mode)
    .eq('status', 'waiting')
    .gte('last_seen', freshSince)
    .order('joined_at', { ascending: true })
    .limit(200);
  amDbError(error);
  if (!queue || queue.length < 2) return { waiting: queue?.length ?? 0 };

  const ids = queue.map((q) => q.user_id);
  const [profilesRes, blocksRes] = await Promise.all([
    admin.from('profiles').select(PROFILE_FIELDS).in('id', ids),
    admin.from('blocks').select('blocker_id, blocked_id').in('blocker_id', ids).in('blocked_id', ids),
  ]);
  amDbError(profilesRes.error);
  amDbError(blocksRes.error);

  const profiles = new Map(profilesRes.data.map((p) => [p.id, p]));
  // Only diagnostic-sourced profiles are matchable. This also covers gated users who joined
  // through `am_join_queue` but have not polled yet (so their row was not deleted).
  const users = queue
    .filter((q) => profiles.get(q.user_id)?.subjects_source === 'diagnostic')
    .map((q) => amNormalizeUser(q, profiles.get(q.user_id)));
  const ctx = {
    now: Date.now(),
    blockSet: amBuildBlockSet(blocksRes.data),
    cooldowns: amCreateCooldownIndex(),
  };

  const plan = amPlanMatches(users, ctx);
  for (const proposal of plan) {
    const { error: claimError } = await admin.rpc('am_claim_proposal', {
      p_mode: proposal.mode,
      p_members: proposal.members.map((m) => ({ user_id: m.userId, teach: m.teach, learn: m.learn })),
    });
    if (claimError) console.error('[match] claim failed', claimError);
  }
  return { waiting: queue.length };
}

async function amProposalView(admin, proposalId) {
  const { data: proposal, error } = await admin
    .from('match_proposals')
    .select('id, mode, status, created_at, expires_at')
    .eq('id', proposalId)
    .maybeSingle();
  amDbError(error);
  if (!proposal) return null;
  const { data: members, error: mErr } = await admin
    .from('proposal_members')
    .select('user_id, accepted, teach_subjects, learn_subjects')
    .eq('proposal_id', proposalId);
  amDbError(mErr);
  const { data: profiles, error: pErr } = await admin
    .from('profiles')
    .select('id, name, avatar_url, school, languages, weak_subjects, strong_subjects, rating_avg, rating_count')
    .in('id', members.map((m) => m.user_id));
  amDbError(pErr);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return { ...proposal, members: members.map((m) => ({ ...m, profile: byId.get(m.user_id) ?? null })) };
}

/** Build the handler; `getAdmin` is injectable so tests can pass a fake client. */
export function amCreateMatchHandler(getAdmin = amAdmin) {
  return amHandler(async ({ req }) => amMatchPoll(getAdmin(), req));
}

async function amMatchPoll(admin, req) {
  const user = await amRequireUser(req, admin);
  await amRequireDiagnostic(admin, user.id);

  await admin.rpc('am_expire_proposals');

  const { data: me, error } = await admin
    .from('match_queue')
    .update({ last_seen: new Date().toISOString() })
    .eq('user_id', user.id)
    .select('*')
    .maybeSingle();
  amDbError(error);
  if (!me) return { status: 'idle' };

  let waiting = 0;
  if (me.status === 'waiting') {
    ({ waiting } = await amRunMatcher(admin, me.mode));
  }

  const { data: current } = await admin.from('match_queue').select('*').eq('user_id', user.id).maybeSingle();
  if (!current) return { status: 'idle' };
  const result = {
    status: current.status,
    mode: current.mode,
    joinedAt: current.joined_at,
    waiting,
  };
  if (current.proposal_id) result.proposal = await amProposalView(admin, current.proposal_id);
  return result;
}

export default amCreateMatchHandler();
