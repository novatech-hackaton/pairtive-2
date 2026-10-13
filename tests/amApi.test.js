// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { amIssueSessionToken } from '../api/amSessionToken.js';
import { amEnforce, amScoreReport } from '../api/amReportVerify.js';
import { AM_PREDICT_MAX_BYTES, amCreatePredictHandler } from '../api/amPredict.js';
import { amCreateMatchHandler } from '../api/amMatch.js';
import { amFromProposal } from '../api/amStartSession.js';
import { amBktParamsFor, amBktPredict } from '../shared/amBkt.js';
import { AmHttpError, amHandler, amRequireUser } from '../server/amServer.js';
import { amFakeAdmin } from './amFakeAdmin.js';

const S = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function amFakeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => (res.headers[k] = v);
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}

describe('api plumbing', () => {
  it('rejects non-POST and hides internal errors', async () => {
    const h = amHandler(async () => {
      throw new Error('secret stack');
    });
    const r1 = amFakeRes();
    await h({ method: 'GET' }, r1);
    expect(r1.statusCode).toBe(405);
    const r2 = amFakeRes();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await h({ method: 'POST', body: {} }, r2);
    spy.mockRestore();
    expect(r2.statusCode).toBe(500);
    expect(r2.body.error).not.toMatch(/secret/);
  });

  it('requires a bearer token', async () => {
    await expect(amRequireUser({ headers: {} }, amFakeAdmin())).rejects.toMatchObject({ status: 401 });
    await expect(amRequireUser({ headers: { authorization: 'Bearer bad' } }, amFakeAdmin())).rejects.toMatchObject({ status: 401 });
  });
});

describe('amSessionToken', () => {
  const tables = () => ({
    session_members: [{ session_id: S, user_id: A, left_at: null }],
    sessions: [{ id: S, daily_room_name: 'pt-x', daily_room_url: 'https://x.daily.co/pt-x', ended_at: null }],
    profiles: [{ id: A, name: 'Ana', status: 'active' }, { id: B, name: 'Ben', status: 'active' }],
  });

  it('rejects non-members', async () => {
    const createToken = vi.fn();
    await expect(amIssueSessionToken(amFakeAdmin(tables()), B, S, createToken)).rejects.toMatchObject({ status: 403 });
    expect(createToken).not.toHaveBeenCalled();
  });

  it('issues a token for members', async () => {
    const createToken = vi.fn(async () => 'tok');
    const out = await amIssueSessionToken(amFakeAdmin(tables()), A, S, createToken);
    expect(out).toEqual({ token: 'tok', url: 'https://x.daily.co/pt-x' });
    expect(createToken).toHaveBeenCalledWith({ roomName: 'pt-x', userId: A, userName: 'Ana' });
  });

  it('rejects ended sessions and suspended users', async () => {
    const t = tables();
    t.sessions[0].ended_at = new Date().toISOString();
    await expect(amIssueSessionToken(amFakeAdmin(t), A, S, vi.fn())).rejects.toMatchObject({ status: 410 });
    const t2 = tables();
    t2.profiles[0] = { id: A, name: 'Ana', status: 'suspended', suspended_until: new Date(Date.now() + 3600e3).toISOString() };
    await expect(amIssueSessionToken(amFakeAdmin(t2), A, S, vi.fn())).rejects.toMatchObject({ status: 403 });
  });
});

describe('amStartSession', () => {
  it('repairs session membership when a concurrent request already created the session', async () => {
    const admin = amFakeAdmin({
      match_proposals: [{ id: P, mode: 'buddy', status: 'accepted' }],
      proposal_members: [
        { proposal_id: P, user_id: A, teach_subjects: ['Math'], learn_subjects: ['English'] },
        { proposal_id: P, user_id: B, teach_subjects: ['English'], learn_subjects: ['Math'] },
      ],
      sessions: [{ id: S, proposal_id: P, daily_room_name: 'pt-p', daily_room_url: 'https://x.daily.co/pt-p', ended_at: null }],
      session_members: [{ session_id: S, user_id: A, teach_subjects: ['Math'], learn_subjects: ['English'] }],
    });
    const ensureRoom = vi.fn();

    await expect(amFromProposal(admin, A, P, ensureRoom)).resolves.toBe(S);
    expect(ensureRoom).not.toHaveBeenCalled();
    expect(admin.db.session_members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ session_id: S, user_id: A }),
        expect.objectContaining({ session_id: S, user_id: B, teach_subjects: ['English'], learn_subjects: ['Math'] }),
      ]),
    );
  });
});

describe('amReportVerify scoring (mocked models)', () => {
  const deps = {
    classifyFrames: vi.fn(async (imgs) => imgs.map(() => ({ predictions: [{ className: 'Porn', probability: 0.92 }] }))),
    classifyText: vi.fn(async () => [{ label: 'insult', results: [{ probabilities: [0.4, 0.6] }] }]),
    decodeLuminance: vi.fn(async (bufs) => bufs.map(() => 3)),
  };

  it('uses frames for inappropriate reports', async () => {
    const admin = amFakeAdmin({ messages: [] }, { 'report-evidence/r/0.jpg': Buffer.from('x') });
    const out = await amScoreReport(admin, { id: 'r', reason: 'inappropriate', reported_id: B, session_id: S, evidence_paths: ['r/0.jpg'] }, deps);
    expect(out.score).toBeCloseTo(0.92);
  });

  it('stores inappropriate reports with no visual evidence', async () => {
    const out = await amScoreReport(amFakeAdmin({ messages: [] }), { id: 'r', reason: 'inappropriate', reported_id: B, session_id: S }, deps);
    expect(out.score).toBeNull();
  });

  it('reads harassment messages server-side for the reported user only', async () => {
    const admin = amFakeAdmin({
      messages: [
        { sender_id: B, session_id: S, body: 'you are dumb', created_at: '2026-01-01' },
        { sender_id: A, session_id: S, body: 'reporter text', created_at: '2026-01-01' },
      ],
    });
    const out = await amScoreReport(admin, { id: 'r', reason: 'harassment', reported_id: B, session_id: S }, deps);
    expect(deps.classifyText).toHaveBeenCalledWith(['you are dumb']);
    expect(out.score).toBeCloseTo(0.6);
  });

  it('no-show: short stay + dark frames', async () => {
    const now = Date.now();
    const admin = amFakeAdmin(
      { session_members: [{ session_id: S, user_id: B, joined_at: new Date(now - 10_000).toISOString(), left_at: new Date(now).toISOString() }] },
      { 'report-evidence/r/0.jpg': Buffer.from('x') },
    );
    const out = await amScoreReport(admin, { id: 'r', reason: 'no_show', reported_id: B, session_id: S, evidence_paths: ['r/0.jpg'] }, deps);
    expect(out.score).toBeGreaterThanOrEqual(0.8);
  });
});

describe('amEnforce', () => {
  const base = () => ({
    strikes: [],
    reports: [],
    profiles: [{ id: B, status: 'active', suspended_until: null }],
    warnings: [],
    match_queue: [{ user_id: B }],
  });

  it('confirmed: strike + 24h suspension + removed from queue', async () => {
    const t = base();
    const report = { id: 'r1', reporter_id: A, reported_id: B, created_at: new Date().toISOString() };
    t.reports.push({ ...report, ai_verdict: 'confirmed', counted_in_strike: false });
    const admin = amFakeAdmin(t);
    const d = await amEnforce(admin, report, 'confirmed');
    expect(d.strike).toBe(true);
    expect(admin.db.strikes).toHaveLength(1);
    expect(admin.db.profiles[0].status).toBe('suspended');
    expect(new Date(admin.db.profiles[0].suspended_until).getTime() - Date.now()).toBeGreaterThan(23 * 3600e3);
    expect(admin.db.match_queue).toHaveLength(0);
  });

  it('uncertain: warning only', async () => {
    const t = base();
    const report = { id: 'r1', reporter_id: A, reported_id: B, created_at: new Date().toISOString() };
    t.reports.push({ ...report, ai_verdict: 'uncertain', counted_in_strike: false });
    const admin = amFakeAdmin(t);
    await amEnforce(admin, report, 'uncertain');
    expect(admin.db.warnings).toHaveLength(1);
    expect(admin.db.profiles[0].status).toBe('active');
  });

  it('safety net: 3 distinct reporters -> suspended even when rejected', async () => {
    const t = base();
    const now = new Date().toISOString();
    t.reports.push(
      { id: 'r1', reporter_id: A, reported_id: B, created_at: now, ai_verdict: 'rejected', counted_in_strike: false },
      { id: 'r2', reporter_id: C, reported_id: B, created_at: now, ai_verdict: 'rejected', counted_in_strike: false },
      { id: 'r3', reporter_id: S, reported_id: B, created_at: now, ai_verdict: 'rejected', counted_in_strike: false },
    );
    const admin = amFakeAdmin(t);
    const d = await amEnforce(admin, t.reports[2], 'rejected');
    expect(d.safetyNet).toBe(true);
    expect(admin.db.profiles[0].status).toBe('suspended');
    expect(admin.db.strikes).toHaveLength(0);
  });
});

// Task 1.3 — amHandler body limit, malformed JSON and error payload extensions.
// Requirements 2.5, 2.7, 2.8, 10.2
describe('amHandler extensions (body limit, malformed JSON, reason/fields)', () => {
  const LIMIT = 16;
  const echo = () => amHandler(async ({ body }) => ({ got: body }), { maxBodyBytes: LIMIT });
  const call = async (h, req) => {
    const res = amFakeRes();
    await h({ method: 'POST', headers: {}, ...req }, res);
    return res;
  };

  it('returns 413 when content-length is one byte over the limit', async () => {
    const fn = vi.fn();
    const h = amHandler(fn, { maxBodyBytes: LIMIT });
    const res = await call(h, { headers: { 'content-length': String(LIMIT + 1) }, body: {} });
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: expect.any(String) });
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns 413 when a raw string body is one byte over the limit (measured in UTF-8 bytes)', async () => {
    const ascii = await call(echo(), { body: 'x'.repeat(LIMIT + 1) });
    expect(ascii.statusCode).toBe(413);
    // 8 two-byte chars = 16 bytes (at limit) plus one more byte -> 17 bytes, 9 chars.
    const multi = await call(echo(), { body: 'é'.repeat(LIMIT / 2) + 'x' });
    expect(multi.statusCode).toBe(413);
  });

  it('accepts a body exactly at the limit', async () => {
    const json = JSON.stringify({ a: 'x'.repeat(LIMIT - 8) }); // {"a":"…"} has 8 bytes of overhead
    expect(Buffer.byteLength(json)).toBe(LIMIT);
    const viaString = await call(echo(), { headers: { 'content-length': String(LIMIT) }, body: json });
    expect(viaString.statusCode).toBe(200);
    expect(viaString.body).toEqual({ got: JSON.parse(json) });
  });

  it('returns 400 on a malformed JSON string body', async () => {
    const fn = vi.fn();
    const res = await call(amHandler(fn), { body: '{"responses": [' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/json/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns 400 when the req.body getter throws (Vercel lazy parse)', async () => {
    const fn = vi.fn();
    const req = { method: 'POST', headers: {} };
    Object.defineProperty(req, 'body', {
      get() {
        throw new SyntaxError('Unexpected token');
      },
    });
    const res = amFakeRes();
    await amHandler(fn)(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/json/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it('applies precedence 405 -> 413 -> 400', async () => {
    const tooBigBad = '{'.repeat(LIMIT + 1);
    const get = amFakeRes();
    await echo()({ method: 'GET', headers: { 'content-length': '999' }, body: tooBigBad }, get);
    expect(get.statusCode).toBe(405);
    expect((await call(echo(), { body: tooBigBad })).statusCode).toBe(413);
    expect((await call(echo(), { body: '{' })).statusCode).toBe(400);
  });

  it('passes reason and fields from AmHttpError into the response body', async () => {
    const h = amHandler(async () => {
      throw new AmHttpError(400, 'Invalid request', { reason: 'invalid-body', fields: { topic_id: 'required' } });
    });
    const res = await call(h, { body: {} });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', reason: 'invalid-body', fields: { topic_id: 'required' } });

    const h403 = amHandler(async () => {
      throw new AmHttpError(403, 'Take the diagnostic first', { reason: 'diagnostic-required' });
    });
    const r403 = await call(h403, { body: {} });
    expect(r403.statusCode).toBe(403);
    expect(r403.body).toEqual({ error: 'Take the diagnostic first', reason: 'diagnostic-required' });
  });

  it('omits reason and fields when not provided, and never leaks them on 5xx', async () => {
    const plain = await call(amHandler(async () => { throw new AmHttpError(404, 'Not found'); }), { body: {} });
    expect(plain.body).toEqual({ error: 'Not found' });

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hidden = await call(
      amHandler(async () => { throw new AmHttpError(500, 'db secret', { reason: 'internal', fields: { x: 'y' } }); }),
      { body: {} },
    );
    spy.mockRestore();
    expect(hidden.statusCode).toBe(500);
    expect(hidden.body).toEqual({ error: 'Something went wrong. Please try again.' });
  });

  it('ignores the size limit when maxBodyBytes is not configured', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(1000) });
    const res = await call(amHandler(async ({ body }) => ({ n: body.a.length })), {
      headers: { 'content-length': String(big.length) },
      body: big,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ n: 1000 });
  });
});

// Task 5.2 — POST /api/amPredict: status codes, Prediction_Result shape, stores nothing.
// Requirements 2.1, 2.5, 2.6, 2.7, 2.8, 2.9
describe('amPredict API', () => {
  const TOPIC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const UNKNOWN_TOPIC = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const AUTH = { authorization: 'Bearer ok' };

  const makeAdmin = () => {
    const admin = amFakeAdmin({ topics: [{ id: TOPIC, topic_name: 'Loops' }] });
    admin.auth.getUser = async (token) =>
      token === 'ok'
        ? { data: { user: { id: A } }, error: null }
        : { data: { user: null }, error: { message: 'bad token' } };
    return admin;
  };

  const call = async (req) => {
    const admin = makeAdmin();
    const res = amFakeRes();
    await amCreatePredictHandler(() => admin)({ method: 'POST', headers: AUTH, ...req }, res);
    return { res, admin };
  };

  const expectNothingStored = (admin) => {
    expect(admin.calls.inserts).toEqual([]);
    expect(admin.calls.updates).toEqual([]);
    expect(admin.calls.rpc).toEqual([]);
  };

  it('returns 200 with a Prediction_Result equal to the BKT port for the topic', async () => {
    const answers = [true, false, true, true];
    const body = { topic_id: TOPIC, responses: answers.map((is_correct, i) => ({ is_correct, difficulty: (i % 3) + 1 })) };
    const { res, admin } = await call({ body });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(amBktPredict(answers, amBktParamsFor('Loops')));
    expect(Object.keys(res.body).sort()).toEqual(['confidence', 'mastery_probability', 'predicted_label', 'probabilities']);
    expect(Object.keys(res.body.probabilities)).toContain(res.body.predicted_label);
    expect(res.body.confidence).toBe(res.body.probabilities[res.body.predicted_label]);
    expect(res.body.mastery_probability).toBeGreaterThanOrEqual(0);
    expect(res.body.mastery_probability).toBeLessThanOrEqual(1);
    const sum = Object.values(res.body.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expectNothingStored(admin);
  });

  it('accepts a JSON string body', async () => {
    const { res } = await call({ body: JSON.stringify({ topic_id: TOPIC, responses: [{ is_correct: true }] }) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(amBktPredict([true], amBktParamsFor('Loops')));
  });

  it('returns 401 without a token or with an invalid token', async () => {
    const body = { topic_id: TOPIC, responses: [{ is_correct: true }] };
    const none = await call({ headers: {}, body });
    expect(none.res.statusCode).toBe(401);
    expectNothingStored(none.admin);
    const bad = await call({ headers: { authorization: 'Bearer nope' }, body });
    expect(bad.res.statusCode).toBe(401);
    expectNothingStored(bad.admin);
  });

  it('returns 405 for non-POST methods', async () => {
    const { res, admin } = await call({ method: 'GET' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
    expectNothingStored(admin);
  });

  it('returns 413 for a body one byte over 10 KB', async () => {
    expect(AM_PREDICT_MAX_BYTES).toBe(10 * 1024);
    const big = 'x'.repeat(AM_PREDICT_MAX_BYTES + 1);
    const viaString = await call({ body: big });
    expect(viaString.res.statusCode).toBe(413);
    expectNothingStored(viaString.admin);
    const viaHeader = await call({
      headers: { ...AUTH, 'content-length': String(AM_PREDICT_MAX_BYTES + 1) },
      body: { topic_id: TOPIC, responses: [{ is_correct: true }] },
    });
    expect(viaHeader.res.statusCode).toBe(413);
    expectNothingStored(viaHeader.admin);
  });

  it('returns 400 on malformed JSON', async () => {
    const { res, admin } = await call({ body: '{"topic_id": ' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/json/i);
    expectNothingStored(admin);
  });

  it('returns 400 naming each invalid field', async () => {
    const missing = await call({ body: { topic_id: TOPIC } });
    expect(missing.res.statusCode).toBe(400);
    expect(missing.res.body.fields).toEqual(expect.arrayContaining([expect.stringMatching(/^responses/)]));

    const bad = await call({
      body: { topic_id: TOPIC, responses: [{ is_correct: 1 }, { is_correct: true, difficulty: 7 }] },
    });
    expect(bad.res.statusCode).toBe(400);
    expect(bad.res.body.fields).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^responses\[0\]\.is_correct/),
        expect.stringMatching(/^responses\[1\]\.difficulty/),
      ]),
    );
    expectNothingStored(missing.admin);
    expectNothingStored(bad.admin);
  });

  it('returns 400 naming topic_id when it is missing or unknown', async () => {
    const missing = await call({ body: { responses: [{ is_correct: true }] } });
    expect(missing.res.statusCode).toBe(400);
    expect(missing.res.body.fields).toEqual(expect.arrayContaining([expect.stringMatching(/^topic_id/)]));

    const unknown = await call({ body: { topic_id: UNKNOWN_TOPIC, responses: [{ is_correct: true }] } });
    expect(unknown.res.statusCode).toBe(400);
    expect(unknown.res.body.fields).toEqual(['topic_id: unknown topic']);
    expectNothingStored(missing.admin);
    expectNothingStored(unknown.admin);
  });
});

// Task 10.3 — POST /api/amMatch diagnostic gate and diagnostic-only planning.
// Requirements 3.3
describe('amMatch diagnostic gate', () => {
  const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const TOPIC = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const AUTH = { authorization: 'Bearer ok' };
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

  // Buddy-mode queue rows; earlier joined_at = longer wait (seeds first).
  const queueRow = (user_id, joinedMsAgo) => ({
    user_id,
    mode: 'buddy',
    status: 'waiting',
    same_school_only: false,
    joined_at: iso(joinedMsAgo),
    last_seen: iso(1_000),
    proposal_id: null,
  });

  // weak/strong are swapped between "x" and "y" profiles so every x/y pair is a two-way match.
  const profile = (id, kind, subjects_source) => ({
    id,
    name: id.slice(0, 4),
    school: '',
    languages: ['English'],
    weak_subjects: kind === 'x' ? ['Loops'] : ['Arrays'],
    strong_subjects: kind === 'x' ? ['Arrays'] : ['Loops'],
    subjects_source,
    rating_avg: 0,
    rating_count: 0,
    success_count: 0,
    sessions_count: 0,
    status: 'active',
    suspended_until: null,
  });

  const makeAdmin = (tables) => {
    const admin = amFakeAdmin({ proposal_members: [], blocks: [], match_proposals: [], ...tables });
    admin.auth.getUser = async (token) =>
      token === 'ok'
        ? { data: { user: { id: A } }, error: null }
        : { data: { user: null }, error: { message: 'bad token' } };
    return admin;
  };

  const call = async (admin) => {
    const res = amFakeRes();
    await amCreateMatchHandler(() => admin)({ method: 'POST', headers: AUTH, body: {} }, res);
    return res;
  };

  const claims = (admin) => admin.calls.rpc.filter((c) => c.name === 'am_claim_proposal');

  it('returns 403 diagnostic-required and deletes the caller queue row when they have no Mastery_Records', async () => {
    const admin = makeAdmin({
      student_topic_mastery: [{ id: 'm1', user_id: B, topic_id: TOPIC }],
      match_queue: [queueRow(A, 20_000), queueRow(B, 10_000)],
      profiles: [profile(A, 'x', 'diagnostic'), profile(B, 'y', 'diagnostic')],
    });

    const res = await call(admin);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: expect.any(String), reason: 'diagnostic-required' });
    expect(admin.db.match_queue.map((q) => q.user_id)).toEqual([B]);
    expect(admin.calls.rpc).toEqual([]);
  });

  it('plans only diagnostic-sourced profiles: onboarding users never appear in a claim', async () => {
    // C and D (onboarding) waited longest and are compatible with A/B, so without the
    // subjects_source filter they would seed the plan and be claimed.
    const admin = makeAdmin({
      student_topic_mastery: [{ id: 'm1', user_id: A, topic_id: TOPIC }],
      match_queue: [queueRow(C, 40_000), queueRow(D, 30_000), queueRow(A, 20_000), queueRow(B, 10_000)],
      profiles: [
        profile(C, 'y', 'onboarding'),
        profile(D, 'x', 'onboarding'),
        profile(A, 'x', 'diagnostic'),
        profile(B, 'y', 'diagnostic'),
      ],
    });

    const res = await call(admin);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: 'waiting', mode: 'buddy', waiting: 4 });
    const claimed = claims(admin);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].args.p_mode).toBe('buddy');
    expect(claimed[0].args.p_members.map((m) => m.user_id).sort()).toEqual([A, B].sort());
    const everyone = claimed.flatMap((c) => c.args.p_members.map((m) => m.user_id));
    expect(everyone).not.toContain(C);
    expect(everyone).not.toContain(D);
    // The caller passed the gate, so their queue row is untouched apart from the heartbeat.
    expect(admin.db.match_queue.map((q) => q.user_id)).toEqual([C, D, A, B]);
  });

  it('makes no claim when the only compatible partner is onboarding-sourced', async () => {
    const admin = makeAdmin({
      student_topic_mastery: [{ id: 'm1', user_id: A, topic_id: TOPIC }],
      match_queue: [queueRow(C, 30_000), queueRow(A, 20_000)],
      profiles: [profile(C, 'y', 'onboarding'), profile(A, 'x', 'diagnostic')],
    });

    const res = await call(admin);

    expect(res.statusCode).toBe(200);
    expect(claims(admin)).toEqual([]);
  });
});
