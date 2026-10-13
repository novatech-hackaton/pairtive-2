import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AM_SUBJECTS } from './amSubjects.js';
import { amPlanMatches } from './amGroupBuilder.js';
import {
  AM_MATCH_CONFIG,
  amBestBuddy,
  amBuildBlockSet,
  amCreateCooldownIndex,
  amHardFilter,
  amPracticeScore,
  amScoreCandidate,
  amSharedStrong,
  amSmoothedRating,
  amSmoothedSuccess,
  amTeachLearn,
  amTeachLearnCopy,
} from './amMatchScore.js';
import * as amLegacy from '../tests/fixtures/amLegacyMatcher.js';

const NOW = 1_800_000_000_000;
let seq = 0;
export function amMakeUser(over = {}) {
  seq += 1;
  return {
    id: over.id ?? `u${seq}`,
    name: over.name ?? `User${seq}`,
    mode: 'buddy',
    sameSchoolOnly: false,
    joinedAt: NOW - 5_000,
    lastSeen: NOW - 1_000,
    status: 'waiting',
    weak: ['Math'],
    strong: ['English'],
    languages: ['English'],
    school: 'UP Diliman',
    ratingAvg: 0,
    ratingCount: 0,
    successCount: 0,
    sessionsCount: 0,
    suspendedUntil: 0,
    ...over,
  };
}
const ctx = (over = {}) => ({ now: NOW, blockSet: new Set(), cooldowns: amCreateCooldownIndex([]), ...over });

describe('scoring', () => {
  it('two-way beats one-way', () => {
    const seed = amMakeUser({ weak: ['Math'], strong: ['English'], joinedAt: NOW - 40_000 });
    const twoWay = amMakeUser({ weak: ['English'], strong: ['Math'] });
    const oneWay = amMakeUser({ weak: ['Science'], strong: ['Math'] });
    const best = amBestBuddy(seed, [oneWay, twoWay], ctx());
    expect(best.user.id).toBe(twoWay.id);
    expect(best.result.twoWay).toBe(true);
  });

  it('one-way matches are only allowed after the configured wait', () => {
    const fresh = amMakeUser({ weak: ['Math'], strong: ['English'], joinedAt: NOW - 5_000 });
    const oneWay = amMakeUser({ weak: ['Science'], strong: ['Math'], joinedAt: NOW - 5_000 });
    expect(amScoreCandidate(fresh, oneWay, ctx())).toBeNull();
    const waited = { ...fresh, joinedAt: NOW - AM_MATCH_CONFIG.relaxAfterMs - 1 };
    expect(amScoreCandidate(waited, oneWay, ctx())).not.toBeNull();
  });

  it('a shared language breaks ties', () => {
    const seed = amMakeUser({ languages: ['Filipino'] });
    const a = amMakeUser({ weak: ['English'], strong: ['Math'], languages: ['Japanese'], joinedAt: NOW - 5_000 });
    const b = amMakeUser({ weak: ['English'], strong: ['Math'], languages: ['Filipino'], joinedAt: NOW - 5_000 });
    expect(amBestBuddy(seed, [a, b], ctx()).user.id).toBe(b.id);
  });

  it('language is a soft boost, not a filter', () => {
    const seed = amMakeUser({ languages: ['Filipino'] });
    const other = amMakeUser({ weak: ['English'], strong: ['Math'], languages: ['Korean'] });
    expect(amBestBuddy(seed, [other], ctx())).not.toBeNull();
  });

  it('smooths ratings so newcomers are not ranked last', () => {
    const newbie = amMakeUser();
    const poor = amMakeUser({ ratingAvg: 2, ratingCount: 20 });
    const great = amMakeUser({ ratingAvg: 4.9, ratingCount: 20 });
    expect(amSmoothedRating(newbie)).toBeGreaterThan(amSmoothedRating(poor));
    expect(amSmoothedRating(great)).toBeGreaterThan(amSmoothedRating(newbie));
    expect(amSmoothedSuccess(newbie)).toBeCloseTo(AM_MATCH_CONFIG.successPrior);
  });

  it('weights sum to 1', () => {
    const sum = Object.values(AM_MATCH_CONFIG.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1);
  });
});

describe('hard filters', () => {
  const a = amMakeUser({ id: 'a', weak: ['Math'], strong: ['English'] });
  const b = amMakeUser({ id: 'b', weak: ['English'], strong: ['Math'] });

  it('passes a compatible pair', () => {
    expect(amHardFilter(a, b, ctx()).ok).toBe(true);
  });
  it('excludes blocked pairs in either direction', () => {
    const blockSet = amBuildBlockSet([{ blocker_id: 'b', blocked_id: 'a' }]);
    expect(amHardFilter(a, b, ctx({ blockSet })).reason).toBe('blocked');
  });
  it('excludes suspended users', () => {
    expect(amHardFilter(a, { ...b, suspendedUntil: NOW + 60_000 }, ctx()).reason).toBe('suspended');
    expect(amHardFilter(a, { ...b, suspendedUntil: NOW - 60_000 }, ctx()).ok).toBe(true);
  });
  it('excludes stale and different-mode users', () => {
    expect(amHardFilter(a, { ...b, lastSeen: NOW - 31_000 }, ctx()).reason).toBe('stale');
    expect(amHardFilter(a, { ...b, mode: 'peers' }, ctx()).reason).toBe('mode');
  });
  it('respects same-school-only when either side enabled it', () => {
    const other = { ...b, school: 'Ateneo' };
    expect(amHardFilter(a, other, ctx()).ok).toBe(true);
    expect(amHardFilter({ ...a, sameSchoolOnly: true }, other, ctx()).reason).toBe('school');
    expect(amHardFilter(a, { ...other, sameSchoolOnly: true }, ctx()).reason).toBe('school');
    expect(amHardFilter({ ...a, sameSchoolOnly: true }, { ...b, school: 'up diliman' }, ctx()).ok).toBe(true);
  });
  it('requires subject overlap', () => {
    const c = amMakeUser({ weak: ['History'], strong: ['Science'] });
    expect(amHardFilter(a, c, ctx()).reason).toBe('no-overlap');
  });
});

describe('repeat matching', () => {
  const session = (ids, minsAgo, status = 'accepted', accepted = true) => ({
    id: `p${Math.random()}`,
    createdAt: NOW - minsAgo * 60_000,
    status,
    mode: 'buddy',
    members: ids.map((userId) => ({ userId, accepted })),
  });

  const declined = (ids, minsAgo) => ({
    ...session(ids, minsAgo, 'declined'),
    members: ids.map((userId, i) => ({ userId, accepted: i === 0 })),
  });

  it('never blocks the same pair after any proposal history', () => {
    const history = [
      session(['a', 'b'], 60),
      declined(['a', 'b'], 30),
      { ...declined(['a', 'b'], 1), status: 'expired' },
    ];
    for (const mode of ['buddy', 'peers']) {
      const cooldowns = amCreateCooldownIndex(history);
      expect(cooldowns.inPairCooldown('a', 'b', NOW, mode)).toBe(false);
    }
    expect(amCreateCooldownIndex(history).matchesSince('a', NOW - 60_000)).toBe(0);
  });

  it('history never removes a compatible buddy candidate', () => {
    const a = amMakeUser({ id: 'a' });
    const b = amMakeUser({ id: 'b', weak: ['English'], strong: ['Math'] });
    const history = [declined(['a', 'b'], 5)];
    const cooldowns = amCreateCooldownIndex(history);
    expect(amBestBuddy(a, [b], ctx({ cooldowns }))?.user.id).toBe('b');
  });

  it('history never removes a compatible peer group', () => {
    const p = {
      ...session(['a', 'b', 'c'], 1, 'declined'),
      mode: 'peers',
      members: [{ userId: 'a', accepted: true }, { userId: 'b', accepted: true }, { userId: 'c', accepted: false }],
    };
    const cd = amCreateCooldownIndex([p]);
    expect(cd.inPairCooldown('a', 'b', NOW, 'peers')).toBe(false);
    expect(cd.inPairCooldown('a', 'c', NOW, 'peers')).toBe(false);
    expect(cd.groupInCooldown(['a', 'b', 'c'], NOW)).toBe(false);
  });

  it('group rule: accepted history never puts a group in cooldown', () => {
    const cd = amCreateCooldownIndex([{ ...session(['a', 'b', 'c'], 30), mode: 'peers' }]);
    expect(cd.groupInCooldown(['a', 'b', 'c'], NOW)).toBe(false); // 3 of 3
    expect(cd.groupInCooldown(['a', 'b', 'c', 'd'], NOW)).toBe(false); // 3 of 4
    expect(cd.inPairCooldown('a', 'b', NOW, 'peers')).toBe(false);
  });
});

describe('teach/learn copy', () => {
  it('builds friendly sentences', () => {
    const me = { weak: ['English'], strong: ['Math'] };
    const copy = amTeachLearnCopy(me, [
      { name: 'Ana', weak: ['Math'], strong: ['English'] },
      { name: 'Ben', weak: ['Math'], strong: ['Science'] },
    ]);
    expect(copy.teach[0].text).toBe("You'll help Ana & Ben with Math");
    expect(copy.learn[0].text).toBe('Ana will help you with English');
    expect(copy.headline).toMatch(/swap/);
  });
});

describe('shared-strong matching', () => {
  it('amSharedStrong dedupes and keeps a\'s order', () => {
    expect(amSharedStrong({ strong: ['B', 'A', 'B', 'C'] }, { strong: ['A', 'B'] })).toEqual(['B', 'A']);
    expect(amSharedStrong({ strong: ['A'] }, {})).toEqual([]);
  });

  it('amPracticeScore saturates at sharedStrongFull', () => {
    expect(amPracticeScore(0)).toBe(0);
    expect(amPracticeScore(1)).toBeCloseTo(1 / 3);
    expect(amPracticeScore(3)).toBe(1);
    expect(amPracticeScore(7)).toBe(1);
  });

  it('accepts a shared-strong pair with zero coverage in both modes', () => {
    const a = amMakeUser({ id: 'a', weak: ['History'], strong: ['Math'] });
    const b = amMakeUser({ id: 'b', weak: ['Science'], strong: ['Math'] });
    expect(amHardFilter(a, b, ctx()).ok).toBe(true);
    expect(amHardFilter({ ...a, mode: 'peers' }, { ...b, mode: 'peers' }, ctx()).ok).toBe(true);
  });

  it('scores a shared-strong pair immediately, with practice reciprocity', () => {
    const a = amMakeUser({ weak: ['History'], strong: ['Math', 'English'], joinedAt: NOW });
    const b = amMakeUser({ weak: ['Science'], strong: ['Math', 'English'], joinedAt: NOW });
    const r = amScoreCandidate(a, b, ctx());
    expect(r).not.toBeNull();
    expect(r.twoWay).toBe(false);
    expect(r.shared).toEqual(['Math', 'English']);
    expect(r.parts.reciprocity).toBeCloseTo(AM_MATCH_CONFIG.sharedStrongFactor * (2 / 3));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it('a perfect two-way swap still outranks a shared-strong match', () => {
    const seed = amMakeUser({ weak: ['Math'], strong: ['English', 'Science', 'History'] });
    const swap = amMakeUser({ weak: ['English'], strong: ['Math'] });
    const practice = amMakeUser({ weak: ['Filipino'], strong: ['English', 'Science', 'History'] });
    expect(amBestBuddy(seed, [practice, swap], ctx()).user.id).toBe(swap.id);
  });

  it('empty overlap matches the legacy matcher exactly', () => {
    const lctx = (c) => ({ ...c, cooldowns: amLegacy.amCreateCooldownIndex([]) });
    const pairs = [
      [{ weak: ['Math'], strong: ['English'] }, { weak: ['English'], strong: ['Math'] }],
      [{ weak: ['Math'], strong: ['English'] }, { weak: ['Science'], strong: ['Math'] }],
      [{ weak: ['Math'], strong: ['English'], joinedAt: NOW - 40_000 }, { weak: ['Science'], strong: ['Math'] }],
      [{ weak: ['History'], strong: ['Science'] }, { weak: ['Math'], strong: ['English'] }],
    ];
    for (const [pa, pb] of pairs) {
      const a = amMakeUser({ id: 'a', ...pa });
      const b = amMakeUser({ id: 'b', ...pb, languages: ['Filipino'], ratingAvg: 4.2, ratingCount: 3 });
      expect(amSharedStrong(a, b)).toEqual([]);
      expect(amHardFilter(a, b, ctx())).toEqual(amLegacy.amHardFilter(a, b, lctx(ctx())));
      const live = amScoreCandidate(a, b, ctx());
      const legacy = amLegacy.amScoreCandidate(a, b, lctx(ctx()), AM_MATCH_CONFIG);
      if (legacy === null) expect(live).toBeNull();
      else {
        expect(live.score).toBe(legacy.score);
        expect(live.twoWay).toBe(legacy.twoWay);
        expect(live.parts).toEqual(legacy.parts);
      }
    }
  });

  it('amTeachLearn reports shared strengths as practice', () => {
    const tl = amTeachLearn({ weak: ['History'], strong: ['Math', 'English'] }, [
      { weak: ['Math'], strong: ['English'] },
    ]);
    expect(tl).toEqual({ teach: ['Math'], learn: [], practice: ['English'] });
  });

  it('practice copy names shared labels and partners', () => {
    const copy = amTeachLearnCopy({ weak: ['History'], strong: ['Algebra', 'Math'] }, [
      { name: 'Ana', weak: ['Science'], strong: ['Algebra'] },
      { name: 'Ben', weak: ['Filipino'], strong: ['Algebra', 'Math'] },
    ]);
    expect(copy.teach).toEqual([]);
    expect(copy.learn).toEqual([]);
    expect(copy.practice.map((p) => p.text)).toEqual([
      'Practice Algebra together with Ana & Ben',
      'Practice Math together with Ben',
    ]);
    expect(copy.headline).toBe('Same strengths: practice together and push each other');
  });

  it('keeps the legacy headline when teach or learn exist, and empty practice otherwise', () => {
    const me = { weak: ['English'], strong: ['Math'] };
    const others = [{ name: 'Ana', weak: ['Math'], strong: ['English'] }];
    const copy = amTeachLearnCopy(me, others);
    const legacy = amLegacy.amTeachLearnCopy(me, others);
    expect(copy).toEqual({ ...legacy, practice: [] });

    const mixed = amTeachLearnCopy({ weak: ['History'], strong: ['Math'] }, [
      { name: 'Ana', weak: ['Math'], strong: ['Math2'] },
      { name: 'Ben', weak: ['Science'], strong: ['Math'] },
    ]);
    expect(mixed.headline).toBe('Your turn to shine: you get to be the tutor');
    expect(mixed.practice[0].text).toBe('Practice Math together with Ben');
  });
});

// Feature: skillgps-matching-integration, Property 13: Empty overlap preserves legacy behavior
describe('Property 13: empty overlap preserves legacy behavior', () => {
  /** Validates: Requirements 6.2, 6.5, 6.6 */
  const LABELS = [...AM_SUBJECTS, 'Algebra', 'Loops', 'Cell Biology', 'Grammar'];

  // Everything about a user except id and strong labels (those are constructed per property).
  const fieldsArb = fc.record({
    mode: fc.constantFrom('buddy', 'peers'),
    status: fc.constantFrom('waiting', 'waiting', 'waiting', 'proposed'),
    sameSchoolOnly: fc.boolean(),
    school: fc.constantFrom('UP Diliman', 'up diliman', 'Ateneo', '', '  '),
    joinedAgo: fc.integer({ min: 0, max: 120_000 }), // includes > relaxAfterMs (30s) waits
    seenAgo: fc.integer({ min: 0, max: 40_000 }), // includes stale (> 30s) heartbeats
    ratingAvg: fc.double({ min: 1, max: 5, noNaN: true }),
    ratingCount: fc.nat(30),
    successCount: fc.nat(30),
    sessionsCount: fc.nat(30),
    suspended: fc.constantFrom('none', 'none', 'active', 'expired'),
    languages: fc.shuffledSubarray(['English', 'Filipino', 'english', 'Japanese'], { maxLength: 3 }),
    weak: fc.shuffledSubarray(LABELS, { maxLength: 4 }),
  });

  const toUser = (id, f, strong) => ({
    id,
    name: `N-${id}`,
    mode: f.mode,
    sameSchoolOnly: f.sameSchoolOnly,
    joinedAt: NOW - f.joinedAgo,
    lastSeen: NOW - f.seenAgo,
    status: f.status,
    weak: f.weak.filter((s) => !strong.includes(s)),
    strong,
    languages: f.languages,
    school: f.school,
    ratingAvg: f.ratingAvg,
    ratingCount: f.ratingCount,
    successCount: f.successCount,
    sessionsCount: f.sessionsCount,
    suspendedUntil: f.suspended === 'active' ? NOW + 60_000 : f.suspended === 'expired' ? NOW - 60_000 : 0,
  });

  const allPairs = (ids) => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b]));
  const blocksArb = (ids) =>
    fc
      .subarray(allPairs(ids), { maxLength: Math.min(3, allPairs(ids).length) })
      .chain((pairs) =>
        fc.tuple(...pairs.map(() => fc.boolean())).map((flips) =>
          pairs.map(([x, y], i) => (flips[i] ? { blocker_id: x, blocked_id: y } : { blocker_id: y, blocked_id: x })),
        ),
      );

  // History is generated to ensure it remains harmless to matching decisions.
  const historyArb = (ids) =>
    fc.array(
      fc.record({
        memberIds: fc.shuffledSubarray(ids, { minLength: 2, maxLength: Math.min(4, ids.length) }),
        accepted: fc.array(fc.constantFrom(true, false, null), { minLength: 4, maxLength: 4 }),
        status: fc.constantFrom('declined', 'expired', 'pending'),
        mode: fc.constantFrom('buddy', 'peers'),
        agoMs: fc.integer({ min: 0, max: 26 * 60 * 60 * 1000 }),
      }),
      { maxLength: 12 },
    ).map((rows) =>
      rows.map((r, i) => ({
        id: `p${i}`,
        createdAt: NOW - r.agoMs,
        status: r.status,
        mode: r.mode,
        members: r.memberIds.map((userId, j) => ({ userId, accepted: r.accepted[j] })),
      })),
    );

  const ctxPair = (blocks) => ({
    live: { now: NOW, blockSet: amBuildBlockSet(blocks), cooldowns: amCreateCooldownIndex() },
    legacy: { now: NOW, blockSet: amLegacy.amBuildBlockSet(blocks), cooldowns: amLegacy.amCreateCooldownIndex([]) },
  });

  it('amHardFilter and amScoreCandidate match the legacy matcher for pairs with no shared strong labels', () => {
    const pairIds = ['a', 'b', 'x', 'y'];
    fc.assert(
      fc.property(
        fieldsArb,
        fieldsArb,
        fc.shuffledSubarray(LABELS, { maxLength: 4 }),
        fc.shuffledSubarray(LABELS, { maxLength: 4 }),
        fc.boolean(),
        fc.option(fc.boolean(), { nil: undefined }),
        blocksArb(pairIds),
        historyArb(pairIds),
        (fa, fb, strongA, strongB, sameMode, requireCoverage, blocks, history) => {
          const a = toUser('a', fa, strongA);
          // Drop every label a is strong in, so the Shared_Strong_Overlap is empty.
          const b = toUser('b', sameMode ? { ...fb, mode: fa.mode } : fb, strongB.filter((s) => !strongA.includes(s)));
          expect(amSharedStrong(a, b)).toEqual([]);
          expect(amSharedStrong(b, a)).toEqual([]);

          const { live, legacy } = ctxPair(blocks, history);
          const opts = requireCoverage === undefined ? {} : { requireCoverage };
          expect(amHardFilter(a, b, live, opts)).toEqual(amLegacy.amHardFilter(a, b, legacy, opts));
          expect(amHardFilter(b, a, live, opts)).toEqual(amLegacy.amHardFilter(b, a, legacy, opts));

          for (const [s, c] of [[a, b], [b, a]]) {
            const got = amScoreCandidate(s, c, live);
            const want = amLegacy.amScoreCandidate(s, c, legacy, AM_MATCH_CONFIG);
            if (want === null) {
              expect(got).toBeNull();
            } else {
              expect(got).not.toBeNull();
              expect(Object.is(got.score, want.score)).toBe(true);
              expect(got.twoWay).toBe(want.twoWay);
              expect(got.parts).toEqual(want.parts);
              expect(got.shared).toEqual([]);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('amPlanMatches matches the legacy planner for queues where no two users share a strong label', () => {
    // Fully random users rarely form a Study Peers group (3+ fresh, waiting, same-mode users),
    // so half of the queues use eligible users, mostly in peers mode, to exercise the group builder.
    const eligibleFieldsArb = fc.record({
      mode: fc.constantFrom('peers', 'peers', 'peers', 'buddy'),
      status: fc.constant('waiting'),
      sameSchoolOnly: fc.constant(false),
      school: fc.constantFrom('UP Diliman', 'Ateneo'),
      joinedAgo: fc.integer({ min: 0, max: 120_000 }),
      seenAgo: fc.integer({ min: 0, max: 20_000 }),
      ratingAvg: fc.double({ min: 1, max: 5, noNaN: true }),
      ratingCount: fc.nat(30),
      successCount: fc.nat(30),
      sessionsCount: fc.nat(30),
      suspended: fc.constantFrom('none', 'expired'),
      languages: fc.shuffledSubarray(['English', 'Filipino', 'english', 'Japanese'], { maxLength: 3 }),
      weak: fc.shuffledSubarray(LABELS, { minLength: 1, maxLength: 4 }),
    });
    const queueArb = fc.tuple(fc.integer({ min: 2, max: 7 }), fc.boolean()).chain(([n, eligible]) => {
      const ids = Array.from({ length: n }, (_, i) => `u${i}`);
      return fc.record({
        ids: fc.constant(ids),
        fields: fc.array(eligible ? eligibleFieldsArb : fieldsArb, { minLength: n, maxLength: n }),
        // Each label is strong for at most one user (-1 = nobody).
        owners: fc.array(fc.integer({ min: -1, max: n - 1 }), { minLength: LABELS.length, maxLength: LABELS.length }),
        blocks: blocksArb(ids),
        history: historyArb(ids),
      });
    });

    const planned = new Set();
    fc.assert(
      fc.property(queueArb, ({ ids, fields, owners, blocks, history }) => {
        const users = ids.map((id, i) =>
          toUser(
            id,
            fields[i],
            LABELS.filter((_, k) => owners[k] === i),
          ),
        );
        for (const [x, y] of allPairs(users)) expect(amSharedStrong(x, y)).toEqual([]);

        const { live, legacy } = ctxPair(blocks, history);
        const got = amPlanMatches(users, live);
        const want = amLegacy.amPlanMatches(users, legacy, AM_MATCH_CONFIG);

        for (const p of got) for (const m of p.members) expect(m.practice).toEqual([]);
        const stripped = got.map((p) => ({
          ...p,
          members: p.members.map(({ practice, ...rest }) => rest),
        }));
        expect(stripped).toEqual(want);
        for (let i = 0; i < want.length; i++) {
          if ('score' in want[i]) expect(Object.is(got[i].score, want[i].score)).toBe(true);
          planned.add(want[i].mode);
        }
      }),
      { numRuns: 300 },
    );
    // Guard against a vacuous run: both buddy pairs and peer groups were actually planned.
    expect([...planned].sort()).toEqual(['buddy', 'peers']);
  });
});
