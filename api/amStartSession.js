// POST /api/amStartSession { proposalId } | { inviteId } -> { sessionId }
// Idempotent: every member calls it; the first creates the Daily room + session row.
import { AmHttpError, amAdmin, amDbError, amEnsureDailyRoom, amHandler, amIsUuid, amRequireUser } from '../server/amServer.js';

export async function amFromProposal(admin, userId, proposalId, ensureRoom = amEnsureDailyRoom) {
  const { data: proposal, error } = await admin
    .from('match_proposals')
    .select('id, mode, status')
    .eq('id', proposalId)
    .maybeSingle();
  amDbError(error);
  if (!proposal) throw new AmHttpError(404, 'Match not found');
  const { data: members, error: mErr } = await admin
    .from('proposal_members')
    .select('user_id, teach_subjects, learn_subjects')
    .eq('proposal_id', proposalId);
  amDbError(mErr);
  if (!members.some((m) => m.user_id === userId)) throw new AmHttpError(403, 'Not your match');
  if (proposal.status !== 'accepted') throw new AmHttpError(409, 'Waiting for everyone to accept');

  let { data: session, error: sessionErr } = await admin
    .from('sessions')
    .select('id, daily_room_name, daily_room_url, ended_at')
    .eq('proposal_id', proposalId)
    .maybeSingle();
  amDbError(sessionErr);

  if (!session) {
    const room = await ensureRoom(`pt-${proposalId}`);
    const { error: insErr } = await admin
      .from('sessions')
      .upsert(
        { proposal_id: proposalId, mode: proposal.mode, daily_room_name: room.name, daily_room_url: room.url },
        { onConflict: 'proposal_id', ignoreDuplicates: true },
      );
    amDbError(insErr);
    const result = await admin
      .from('sessions')
      .select('id, daily_room_name, daily_room_url, ended_at')
      .eq('proposal_id', proposalId)
      .single();
    amDbError(result.error);
    session = result.data;
  }
  if (session.ended_at) throw new AmHttpError(410, 'That session already ended');

  // A concurrent request may have created the session row but not its room fields yet.
  if (!session.daily_room_name || !session.daily_room_url) {
    const room = await ensureRoom(`pt-${proposalId}`);
    const { error: repairErr } = await admin
      .from('sessions')
      .update({ daily_room_name: room.name, daily_room_url: room.url })
      .eq('id', session.id);
    amDbError(repairErr);
  }

  const { error: smErr } = await admin.from('session_members').upsert(
    members.map((m) => ({
      session_id: session.id,
      user_id: m.user_id,
      teach_subjects: m.teach_subjects,
      learn_subjects: m.learn_subjects,
    })),
    { onConflict: 'session_id,user_id', ignoreDuplicates: true },
  );
  amDbError(smErr);
  return session.id;
}

async function amFromInvite(admin, userId, inviteId) {
  const { data: invite, error } = await admin
    .from('session_invites')
    .select('id, conversation_id, from_user, mode, status, created_at')
    .eq('id', inviteId)
    .maybeSingle();
  amDbError(error);
  if (!invite) throw new AmHttpError(404, 'Invite not found');
  const { data: members, error: mErr } = await admin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', invite.conversation_id);
  amDbError(mErr);
  if (!members.some((m) => m.user_id === userId)) throw new AmHttpError(403, 'Not your invite');
  if (invite.status !== 'accepted') throw new AmHttpError(409, 'Waiting for them to accept');
  if (Date.now() - new Date(invite.created_at).getTime() > 30 * 60 * 1000) throw new AmHttpError(410, 'This invite expired');

  const { data: prof } = await admin.from('profiles').select('status, suspended_until').eq('id', userId).single();
  if (prof?.status === 'suspended' && new Date(prof.suspended_until) > new Date()) throw new AmHttpError(403, 'Your account is suspended');

  let { data: session } = await admin.from('sessions').select('id, ended_at').eq('invite_id', inviteId).maybeSingle();
  if (!session) {
    const room = await amEnsureDailyRoom(`pt-i-${inviteId}`);
    const { error: insErr } = await admin
      .from('sessions')
      .upsert(
        { invite_id: inviteId, mode: invite.mode, daily_room_name: room.name, daily_room_url: room.url },
        { onConflict: 'invite_id', ignoreDuplicates: true },
      );
    amDbError(insErr);
    ({ data: session } = await admin.from('sessions').select('id, ended_at').eq('invite_id', inviteId).single());
  }
  if (session.ended_at) throw new AmHttpError(410, 'That call already ended');

  const { error: smErr } = await admin
    .from('session_members')
    .upsert({ session_id: session.id, user_id: userId }, { onConflict: 'session_id,user_id', ignoreDuplicates: true });
  amDbError(smErr);
  return session.id;
}

export default amHandler(async ({ req, body }) => {
  const admin = amAdmin();
  const user = await amRequireUser(req, admin);
  if (amIsUuid(body.proposalId)) return { sessionId: await amFromProposal(admin, user.id, body.proposalId) };
  if (amIsUuid(body.inviteId)) return { sessionId: await amFromInvite(admin, user.id, body.inviteId) };
  throw new AmHttpError(400, 'proposalId or inviteId is required');
});
