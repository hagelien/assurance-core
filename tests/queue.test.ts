/**
 * Review-queue eligibility and batching.
 *
 * The three eligibility rules are the reason this moved out of a host: written
 * once per target type they agree only for as long as someone keeps them in
 * step, and both directions of drift are invisible in production — a queue
 * showing one row too few looks like a quiet backlog, and one showing a row
 * too many looks like a diligent reviewer.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryAssuranceStore,
  candidatesFromStore,
  filterEligible,
  judgedVersions,
  selectReviewBatch,
  selectReviewQueue,
  type ActorSnapshot,
  type ReviewCandidate,
} from '../src/index.js';

const T = (n: number): string =>
  `2020-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;

const actor = (actorRef: string, kind: 'human' | 'agent' = 'human'): ActorSnapshot => ({
  actorRef,
  kind,
  capabilities: [],
  assuranceCapabilities: [],
});

function candidate(
  id: string,
  over: Partial<ReviewCandidate> & { type?: string } = {},
): ReviewCandidate {
  const { type, ...rest } = over;
  return {
    version: { proposalId: `p-${id}`, versionId: `v-${id}` },
    target: { space: 's', type: type ?? 'note', id },
    createdAt: T(1),
    authorRef: 'user:1',
    visible: true,
    ...rest,
  };
}

describe('filterEligible — the three rules', () => {
  it('drops a row the reviewer may not see', () => {
    const c = candidate('a', { visible: false });
    const { eligible, excluded } = filterEligible({
      candidates: [c],
      reviewerRef: 'user:9',
      judged: new Set(),
    });
    expect(eligible).toEqual([]);
    expect(excluded[0]!.reason).toBe('not_visible');
  });

  it('drops a row the reviewer wrote', () => {
    const { eligible, excluded } = filterEligible({
      candidates: [candidate('a', { authorRef: 'user:9' })],
      reviewerRef: 'user:9',
      judged: new Set(),
    });
    expect(eligible).toEqual([]);
    expect(excluded[0]!.reason).toBe('authored_by_caller');
  });

  it('keeps a row the reviewer wrote when self-review is granted', () => {
    const { eligible } = filterEligible({
      candidates: [candidate('a', { authorRef: 'user:9' })],
      reviewerRef: 'user:9',
      selfReviewEnabled: true,
      judged: new Set(),
    });
    expect(eligible).toHaveLength(1);
  });

  it('never treats a null author as the caller', () => {
    const { eligible } = filterEligible({
      candidates: [candidate('a', { authorRef: null })],
      reviewerRef: 'user:9',
      judged: new Set(),
    });
    expect(eligible).toHaveLength(1);
  });

  it('drops a row the reviewer has already judged', () => {
    const c = candidate('a');
    const { excluded } = filterEligible({
      candidates: [c],
      reviewerRef: 'user:9',
      judged: new Set(['p-a#v-a']),
    });
    expect(excluded[0]!.reason).toBe('already_judged');
  });

  it('reports the first applicable reason, not all of them', () => {
    // Invisible AND authored by the caller AND judged. A diagnostic listing
    // three reasons says less than one saying which rule stopped it.
    const c = candidate('a', { visible: false, authorRef: 'user:9' });
    const { excluded } = filterEligible({
      candidates: [c],
      reviewerRef: 'user:9',
      judged: new Set(['p-a#v-a']),
    });
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.reason).toBe('not_visible');
  });
});

describe('selectReviewBatch', () => {
  it('serves oldest first', () => {
    const items = [
      candidate('new', { createdAt: T(9) }),
      candidate('old', { createdAt: T(1) }),
    ];
    expect(selectReviewBatch(items, 10).map((i) => i.target.id)).toEqual([
      'old',
      'new',
    ]);
  });

  it('breaks a same-instant tie stably', () => {
    // Two rows created in the same millisecond must not swap places between
    // calls, or every diagnostic comparing two runs becomes noise.
    const items = [candidate('b', { createdAt: T(1) }), candidate('a', { createdAt: T(1) })];
    const first = selectReviewBatch(items, 10).map((i) => i.target.id);
    const second = selectReviewBatch([...items].reverse(), 10).map((i) => i.target.id);
    expect(first).toEqual(second);
  });

  it('honours a limit', () => {
    const items = [candidate('a'), candidate('b'), candidate('c')];
    expect(selectReviewBatch(items, 2)).toHaveLength(2);
  });

  it('returns nothing for a non-positive limit', () => {
    expect(selectReviewBatch([candidate('a')], 0)).toEqual([]);
    expect(selectReviewBatch([candidate('a')], -1)).toEqual([]);
  });

  it('reserves a share for a type that oldest-first would bury', () => {
    // Ten old notes and one new record. Without a reserve the record never
    // appears at a limit of 4, which is the starvation the reserves exist for.
    const notes = Array.from({ length: 10 }, (_, i) =>
      candidate(`n${i}`, { createdAt: T(1) }),
    );
    const record = candidate('r', { type: 'record', createdAt: T(9) });
    const withoutReserve = selectReviewBatch([...notes, record], 4);
    expect(withoutReserve.some((i) => i.target.type === 'record')).toBe(false);

    const withReserve = selectReviewBatch([...notes, record], 4, [
      { targetType: 'record', fraction: 0.25 },
    ]);
    expect(withReserve.some((i) => i.target.type === 'record')).toBe(true);
    expect(withReserve).toHaveLength(4);
  });

  it('does not serve a reserved row twice', () => {
    const record = candidate('r', { type: 'record' });
    const served = selectReviewBatch([record, candidate('n')], 5, [
      { targetType: 'record', fraction: 1 },
      { targetType: 'record', fraction: 1 },
    ]);
    expect(served.filter((i) => i.target.id === 'r')).toHaveLength(1);
  });

  it('never exceeds the limit however large the reserves', () => {
    const items = Array.from({ length: 20 }, (_, i) => candidate(`n${i}`));
    expect(
      selectReviewBatch(items, 3, [{ targetType: 'note', fraction: 1 }]),
    ).toHaveLength(3);
  });
});

describe('judgedVersions — an implicit stake is not a judgment', () => {
  async function seeded(): Promise<{
    store: MemoryAssuranceStore;
    candidates: ReviewCandidate[];
  }> {
    const store = new MemoryAssuranceStore();
    const candidates: ReviewCandidate[] = [];
    for (const id of ['a', 'b']) {
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type: 'note', id },
        author: actor('user:1'),
        createdAt: T(1),
      });
      store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}` });
      candidates.push(candidate(id));
    }
    return { store, candidates };
  }

  it('counts an explicit verdict', async () => {
    const { store, candidates } = await seeded();
    await store.recordAssessment({
      version: { proposalId: 'p-a', versionId: 'v-a' },
      assessorRef: 'agent:7',
      assessorKind: 'agent',
      verdict: 'approve',
      recordedAt: T(2),
    });
    expect([...(await judgedVersions(store, 'agent:7', candidates))]).toEqual([
      'p-a#v-a',
    ]);
  });

  it('ignores an implicit one', async () => {
    // A self-reviewing author has an implicit row on everything they
    // submitted. Counting it hides exactly the work the grant exists to
    // surface.
    const { store, candidates } = await seeded();
    await store.recordAssessment({
      version: { proposalId: 'p-a', versionId: 'v-a' },
      assessorRef: 'user:1',
      assessorKind: 'human',
      verdict: 'approve',
      implicit: true,
      recordedAt: T(2),
    });
    expect(await judgedVersions(store, 'user:1', candidates)).toEqual(new Set());
  });

  it('asks the store nothing when there are no candidates', async () => {
    const store = new MemoryAssuranceStore();
    let asked = 0;
    const spy = store.assessmentsByActor.bind(store);
    store.assessmentsByActor = async (ref, versions) => {
      asked += 1;
      return spy(ref, versions);
    };
    expect(await judgedVersions(store, 'user:1', [])).toEqual(new Set());
    expect(asked).toBe(0);
  });
});

describe('selectReviewQueue — the whole selection', () => {
  it('excludes the reviewer’s own work and what they have judged', async () => {
    const store = new MemoryAssuranceStore();
    for (const [id, authorRef] of [
      ['mine', 'agent:7'],
      ['judged', 'user:1'],
      ['fresh', 'user:1'],
    ] as const) {
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type: 'note', id },
        author: actor(authorRef, authorRef.startsWith('agent') ? 'agent' : 'human'),
        createdAt: T(1),
      });
      store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}` });
    }
    await store.recordAssessment({
      version: { proposalId: 'p-judged', versionId: 'v-judged' },
      assessorRef: 'agent:7',
      assessorKind: 'agent',
      verdict: 'approve',
      recordedAt: T(2),
    });

    const result = await selectReviewQueue({
      store,
      reviewerRef: 'agent:7',
      candidates: [
        candidate('mine', { authorRef: 'agent:7' }),
        candidate('judged'),
        candidate('fresh'),
      ],
      limit: 10,
    });

    expect(result.items.map((i) => i.target.id)).toEqual(['fresh']);
    expect(result.examined).toBe(3);
    expect(
      result.excluded.map((e) => [e.candidate.target.id, e.reason]),
    ).toEqual([
      ['mine', 'authored_by_caller'],
      ['judged', 'already_judged'],
    ]);
  });
});

describe('candidatesFromStore', () => {
  function store(): MemoryAssuranceStore {
    return new MemoryAssuranceStore();
  }

  it('draws open proposals with a submitted version', async () => {
    const s = store();
    s.seedProposal({
      proposalId: 'p1',
      target: { space: 's', type: 'note', id: 'n1' },
      author: actor('user:1'),
      createdAt: T(1),
    });
    s.seedVersion({ proposalId: 'p1', versionId: 'v1', submittedAt: T(2) });
    const [c] = await candidatesFromStore(s, 's');
    expect(c!.version).toEqual({ proposalId: 'p1', versionId: 'v1' });
    expect(c!.authorRef).toBe('user:1');
    expect(c!.createdAt).toBe(T(2));
  });

  it('skips a proposal whose version was never submitted', async () => {
    // Nothing to show a reviewer. Skipped rather than reported as excluded,
    // because it never became a candidate.
    const s = store();
    s.seedProposal({
      proposalId: 'p1',
      target: { space: 's', type: 'note', id: 'n1' },
      author: actor('user:1'),
      createdAt: T(1),
    });
    s.seedVersion({ proposalId: 'p1', versionId: 'v1', submittedAt: null });
    expect(await candidatesFromStore(s, 's')).toEqual([]);
  });

  it('takes the latest version when a proposal was revised', async () => {
    const s = store();
    s.seedProposal({
      proposalId: 'p1',
      target: { space: 's', type: 'note', id: 'n1' },
      author: actor('user:1'),
      createdAt: T(1),
    });
    s.seedVersion({ proposalId: 'p1', versionId: 'v1', submittedAt: T(1) });
    s.seedVersion({ proposalId: 'p1', versionId: 'v2', submittedAt: T(3) });
    const [c] = await candidatesFromStore(s, 's');
    expect(c!.version.versionId).toBe('v2');
  });

  it('does not reach into another space', async () => {
    const s = store();
    s.seedProposal({
      proposalId: 'p1',
      target: { space: 'other', type: 'note', id: 'n1' },
      author: actor('user:1'),
      createdAt: T(1),
    });
    s.seedVersion({ proposalId: 'p1', versionId: 'v1' });
    expect(await candidatesFromStore(s, 's')).toEqual([]);
  });
});
