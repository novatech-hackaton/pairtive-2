// @vitest-environment node
// Runs every Supabase migration against an in-process Postgres (PGlite) and exercises
// the RPCs + RLS rules that matter most: atomic claiming, accept/next, ratings, threads, reports.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const migrationsDir = join(root, 'supabase', 'migrations');

let db;
const ids = {};

async function asUser(uid, sql, params = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}
async function asService(sql, params = []) {
  await db.exec('set role service_role;');
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role;');
  }
}
const scalar = (res) => Object.values(res.rows[0] ?? {})[0];

async function createUser(key, { weak, strong, school = 'UP Diliman' }) {
  const res = await db.query(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
    [`${key}@example.com`, JSON.stringify({ full_name: key })],
  );
  const id = res.rows[0].id;
  ids[key] = id;
  await asUser(
    id,
    `update public.profiles set name = $1, school = $2, languages = $3, weak_subjects = $4, strong_subjects = $5,
       onboarded = true, rules_accepted_at = now() where id = auth.uid()`,
    [key, school, ['English'], weak, strong],
  );
  return id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(join(root, 'tests', 'amSupabaseStub.sql'), 'utf8'));
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  await createUser('ana', { weak: ['Math'], strong: ['English'] });
  await createUser('ben', { weak: ['English'], strong: ['Math'] });
  await createUser('cy', { weak: ['English'], strong: ['Math'] });
  await createUser('dee', { weak: ['Science'], strong: ['History'] });
}, 60_000);

describe('profiles', () => {
  it('creates a profile for every new auth user', async () => {
    const res = await db.query('select count(*)::int as n from public.profiles');
    expect(res.rows[0].n).toBe(4);
  });

  it('lets users edit their own fields but not stats or moderation fields', async () => {
    await expect(asUser(ids.ana, `update public.profiles set rating_avg = 5 where id = auth.uid()`)).rejects.toThrow(/permission/);
    await expect(asUser(ids.ana, `update public.profiles set status = 'active' where id = auth.uid()`)).rejects.toThrow(/permission/);
    const res = await asUser(ids.ana, `update public.profiles set name = 'Ana' where id = $1 returning id`, [ids.ben]);
    expect(res.rows).toHaveLength(0); // RLS: can't edit someone else
  });

  it('rejects overlapping weak/strong subjects', async () => {
    await expect(
      asUser(ids.ana, `update public.profiles set strong_subjects = array['Math'] where id = auth.uid()`),
    ).rejects.toThrow(/am_profiles_subjects_check/);
  });
});

describe('matching', () => {
  it('requires agreeing to the rules before joining the queue', async () => {
    const res = await db.query(`insert into auth.users (email) values ('new@example.com') returning id`);
    await expect(asUser(res.rows[0].id, `select public.am_join_queue('buddy', false)`)).rejects.toThrow(/profile/);
  });

  it('claims atomically and cannot double-book a user', async () => {
    await asUser(ids.ana, `select public.am_join_queue('buddy', false)`);
    await asUser(ids.ben, `select public.am_join_queue('buddy', false)`);
    await asUser(ids.cy, `select public.am_join_queue('buddy', false)`);
    const members = (a, b) => JSON.stringify([{ user_id: a, teach: [], learn: [] }, { user_id: b, teach: [], learn: [] }]);

    const first = scalar(await asService(`select public.am_claim_proposal('buddy', $1::jsonb)`, [members(ids.ana, ids.ben)]));
    expect(first).toBeTruthy();
    const second = scalar(await asService(`select public.am_claim_proposal('buddy', $1::jsonb)`, [members(ids.ana, ids.cy)]));
    expect(second).toBeNull();
    ids.proposal1 = first;
  });

  it('only service role can claim', async () => {
    await expect(asUser(ids.cy, `select public.am_claim_proposal('buddy', '[]'::jsonb)`)).rejects.toThrow(/permission/);
  });

  it('ignores stale queue rows', async () => {
    await db.query(`update public.match_queue set last_seen = now() - interval '1 minute' where user_id = $1`, [ids.cy]);
    await asUser(ids.dee, `select public.am_join_queue('buddy', false)`);
    const members = JSON.stringify([{ user_id: ids.cy }, { user_id: ids.dee }]);
    expect(scalar(await asService(`select public.am_claim_proposal('buddy', $1::jsonb)`, [members]))).toBeNull();
    await asUser(ids.cy, `select public.am_heartbeat()`);
  });

  it('members can see their proposal, others cannot', async () => {
    const mine = await asUser(ids.ana, `select id from public.match_proposals`);
    expect(mine.rows.map((r) => r.id)).toContain(ids.proposal1);
    const theirs = await asUser(ids.dee, `select id from public.match_proposals`);
    expect(theirs.rows).toHaveLength(0);
  });

  it('Next: decliner goes to the back, the other keeps their place', async () => {
    const before = await db.query(`select user_id, joined_at from public.match_queue where user_id in ($1, $2)`, [ids.ana, ids.ben]);
    const joined = Object.fromEntries(before.rows.map((r) => [r.user_id, new Date(r.joined_at).getTime()]));
    expect(scalar(await asUser(ids.ana, `select public.am_respond_proposal($1, true)`, [ids.proposal1]))).toBe('pending');
    expect(scalar(await asUser(ids.ben, `select public.am_respond_proposal($1, false)`, [ids.proposal1]))).toBe('declined');
    const after = await db.query(`select user_id, status, joined_at from public.match_queue where user_id in ($1, $2)`, [ids.ana, ids.ben]);
    const rows = Object.fromEntries(after.rows.map((r) => [r.user_id, r]));
    expect(rows[ids.ana].status).toBe('waiting');
    expect(new Date(rows[ids.ana].joined_at).getTime()).toBe(joined[ids.ana]);
    expect(rows[ids.ben].status).toBe('waiting');
  });

  it('all accept -> accepted and in_session', async () => {
    const members = JSON.stringify([{ user_id: ids.ana }, { user_id: ids.cy }]);
    const pid = scalar(await asService(`select public.am_claim_proposal('buddy', $1::jsonb)`, [members]));
    expect(pid).toBeTruthy();
    await asUser(ids.ana, `select public.am_respond_proposal($1, true)`, [pid]);
    expect(scalar(await asUser(ids.cy, `select public.am_respond_proposal($1, true)`, [pid]))).toBe('accepted');
    const q = await db.query(`select status from public.match_queue where proposal_id = $1`, [pid]);
    expect(q.rows.every((r) => r.status === 'in_session')).toBe(true);
    ids.proposal2 = pid;
  });

  it('expires timed-out proposals and removes AFK users', async () => {
    const members = JSON.stringify([{ user_id: ids.ben }, { user_id: ids.dee }]);
    const pid = scalar(await asService(`select public.am_claim_proposal('buddy', $1::jsonb)`, [members]));
    expect(pid).toBeTruthy();
    await asUser(ids.ben, `select public.am_respond_proposal($1, true)`, [pid]);
    await db.query(`update public.match_proposals set expires_at = now() - interval '10 seconds' where id = $1`, [pid]);
    await asService(`select public.am_expire_proposals()`);
    const p = await db.query(`select status from public.match_proposals where id = $1`, [pid]);
    expect(p.rows[0].status).toBe('expired');
    const q = await db.query(`select user_id, status from public.match_queue where user_id in ($1, $2)`, [ids.ben, ids.dee]);
    expect(q.rows.map((r) => r.user_id)).toEqual([ids.ben]);
    expect(q.rows[0].status).toBe('waiting');
  });
});

describe('sessions, ratings and threads', () => {
  beforeAll(async () => {
    const s = await asService(
      `insert into public.sessions (proposal_id, mode, daily_room_name) values ($1, 'buddy', 'pt-test') returning id`,
      [ids.proposal2],
    );
    ids.session = s.rows[0].id;
    await asService(`insert into public.session_members (session_id, user_id) values ($1, $2), ($1, $3)`, [ids.session, ids.ana, ids.cy]);
    await asUser(ids.ana, `select public.am_mark_joined($1)`, [ids.session]);
    await asUser(ids.cy, `select public.am_mark_joined($1)`, [ids.session]);
  });

  it('grants authenticated users the browser privileges needed for ratings and chat', async () => {
    const result = await db.query(`
      select
        has_table_privilege('authenticated', 'public.ratings', 'SELECT') as ratings_select,
        has_table_privilege('authenticated', 'public.ratings', 'INSERT') as ratings_insert,
        has_table_privilege('authenticated', 'public.messages', 'SELECT') as messages_select,
        has_table_privilege('authenticated', 'public.messages', 'INSERT') as messages_insert
    `);
    expect(result.rows[0]).toEqual({ ratings_select: true, ratings_insert: true, messages_select: true, messages_insert: true });
  });

  it('blocks ratings for sessions shorter than 1 minute', async () => {
    await expect(
      asUser(ids.ana, `insert into public.ratings (session_id, rater_id, ratee_id, stars) values ($1, auth.uid(), $2, 5)`, [ids.session, ids.cy]),
    ).rejects.toThrow(/row-level security/);
  });

  it('accepts one rating per partner and updates aggregates', async () => {
    await db.query(`update public.session_members set joined_at = now() - interval '5 minutes' where session_id = $1`, [ids.session]);
    await asUser(ids.ana, `insert into public.ratings (session_id, rater_id, ratee_id, stars, tags) values ($1, auth.uid(), $2, 4, array['Helpful'])`, [ids.session, ids.cy]);
    await expect(
      asUser(ids.ana, `insert into public.ratings (session_id, rater_id, ratee_id, stars) values ($1, auth.uid(), $2, 5)`, [ids.session, ids.cy]),
    ).rejects.toThrow(/duplicate|unique/);
    const p = await db.query(`select rating_avg::float as avg, rating_count from public.profiles where id = $1`, [ids.cy]);
    expect(p.rows[0]).toEqual({ avg: 4, rating_count: 1 });
  });

  it('only session members can read the session and its realtime channel', async () => {
    expect((await asUser(ids.ana, `select id from public.sessions`)).rows).toHaveLength(1);
    expect((await asUser(ids.dee, `select id from public.sessions`)).rows).toHaveLength(0);
    expect(scalar(await asUser(ids.ana, `select public.am_session_topic_member($1)`, [`session:${ids.session}`]))).toBe(true);
    expect(scalar(await asUser(ids.dee, `select public.am_session_topic_member($1)`, [`session:${ids.session}`]))).toBe(false);
    expect(scalar(await asUser(ids.ana, `select public.am_session_topic_member('session:not-a-uuid')`))).toBe(false);
  });

  it('creates exactly one thread per set of people', async () => {
    const a = scalar(await asUser(ids.ana, `select public.am_get_or_create_conversation($1::uuid[])`, [[ids.cy]]));
    const b = scalar(await asUser(ids.cy, `select public.am_get_or_create_conversation($1::uuid[])`, [[ids.ana]]));
    expect(a).toBe(b);
    ids.conversation = a;
    const count = await db.query(`select count(*)::int as n from public.conversations`);
    expect(count.rows[0].n).toBe(1);
  });

  it('threads only show in the list once a message exists', async () => {
    expect((await asUser(ids.ana, `select * from public.am_list_conversations()`)).rows).toHaveLength(0);
    await asUser(ids.ana, `insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), 'hi!')`, [ids.conversation]);
    const list = await asUser(ids.cy, `select * from public.am_list_conversations()`);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].unread).toBe(1);
    expect(list.rows[0].members[0].name).toBe('ana');
  });

  it('rejects threads with people you never studied with', async () => {
    await expect(asUser(ids.ana, `select public.am_get_or_create_conversation($1::uuid[])`, [[ids.dee]])).rejects.toThrow(/studied/);
  });

  it('non-members cannot read or post messages', async () => {
    expect((await asUser(ids.dee, `select * from public.messages`)).rows).toHaveLength(0);
    await expect(
      asUser(ids.dee, `insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), 'x')`, [ids.conversation]),
    ).rejects.toThrow(/row-level security/);
  });

  it('a report blocks both ways immediately, and duplicates are refused', async () => {
    const rid = scalar(
      await asUser(ids.cy, `select public.am_create_report($1, 'harassment', 'rude', $2, null)`, [ids.ana, ids.session]),
    );
    expect(rid).toBeTruthy();
    expect(scalar(await db.query(`select public.am_is_blocked($1, $2)`, [ids.ana, ids.cy]))).toBe(true);
    await expect(
      asUser(ids.ana, `insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), 'hey')`, [ids.conversation]),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(ids.cy, `select public.am_create_report($1, 'spam', null, $2, null)`, [ids.ana, ids.session]),
    ).rejects.toThrow(/already reported/);
    const reportsSeenByReported = await asUser(ids.ana, `select * from public.reports`);
    expect(reportsSeenByReported.rows).toHaveLength(0);
  });

  it('leaving ends the session and updates stats', async () => {
    const secs = scalar(await asUser(ids.ana, `select public.am_leave_session($1)`, [ids.session]));
    expect(secs).toBeGreaterThanOrEqual(299);
    await asUser(ids.cy, `select public.am_leave_session($1)`, [ids.session]);
    const s = await db.query(`select ended_at from public.sessions where id = $1`, [ids.session]);
    expect(s.rows[0].ended_at).not.toBeNull();
    const p = await db.query(`select sessions_count, success_count from public.profiles where id = $1`, [ids.ana]);
    expect(p.rows[0]).toEqual({ sessions_count: 1, success_count: 1 });
  });
});
