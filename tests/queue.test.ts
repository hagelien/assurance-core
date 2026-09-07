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
  selectReviewQueueFromStore,
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

describe('selectReviewQueueFromStore — the window has to outlast the rules', () => {
  /**
   * `n` open proposals in one space, strictly oldest-first, all by someone else.
   *
   * Distinct ages on purpose: the store orders on `(createdAt, proposalId)` and
   * the batch on the version's own age, so a fixture with repeated timestamps
   * would make an ordering assertion here a statement about tie-breaks rather
   * than about the window.
   */
  const age = (i: number): string =>
    `2020-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`;

  function backlog(n: number): MemoryAssuranceStore {
    const store = new MemoryAssuranceStore();
    for (let i = 0; i < n; i += 1) {
      const id = `n${String(i).padStart(4, '0')}`;
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type: 'note', id },
        author: actor('user:1'),
        createdAt: age(i),
      });
      store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}`, submittedAt: age(i) });
    }
    return store;
  }

  async function judgeFirst(
    store: MemoryAssuranceStore,
    reviewerRef: string,
    n: number,
  ): Promise<void> {
    const oldest = await store.listOpenProposals('s', { limit: n });
    for (const proposal of oldest) {
      await store.recordAssessment({
        version: { proposalId: proposal.proposalId, versionId: `v-${proposal.target.id}` },
        assessorRef: reviewerRef,
        assessorKind: 'agent',
        verdict: 'approve',
        recordedAt: T(2),
      });
    }
  }

  it('serves a full batch from behind a window the reviewer has judged', async () => {
    // The production reproduction, in miniature: the reviewer has judged every
    // one of the oldest `limit` rows, so a selection that read `limit` and then
    // applied the rules serves nothing at all — while an SQL queue filtering
    // ahead of its own LIMIT serves a full batch from further back.
    const store = backlog(60);
    await judgeFirst(store, 'agent:7', 10);

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
    });

    expect(result.items).toHaveLength(10);
    expect(result.truncated).toBe(false);
    // And it is the work immediately behind the judged prefix, in age order —
    // growing the window must not reorder the backlog.
    expect(result.items.map((i) => i.target.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `n${String(i + 10).padStart(4, '0')}`),
    );
  });

  it('stops at the cap and says the batch is short because it stopped', async () => {
    // The other half: a short batch must not be read as an empty backlog when
    // the search was the thing that ended. There is eligible work here — it is
    // past the cap.
    const store = backlog(60);
    await judgeFirst(store, 'agent:7', 40);

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
      maxCandidateWindow: 20,
    });

    expect(result.items).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });

  it('does not claim truncation at a cap the backlog exactly fills', async () => {
    // The boundary the sentinel exists for. The space holds precisely
    // `maxCandidateWindow` proposals, so the capped read returns precisely that
    // many and looks identical to a space holding a million more — and with
    // some of them ineligible the search ends at the cap. Without the extra
    // row it reported a hidden backlog over a space it had read to the end,
    // which is this flag's own distinction inverted.
    const store = backlog(20);
    await judgeFirst(store, 'agent:7', 15);

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
      maxCandidateWindow: 20,
    });

    expect(result.items).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  it('does not claim truncation when the space simply runs out', async () => {
    const store = backlog(12);
    await judgeFirst(store, 'agent:7', 8);

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
    });

    expect(result.items).toHaveLength(4);
    expect(result.truncated).toBe(false);
  });

  it('keeps growing until a reserved type has been looked for', async () => {
    // The starvation `reserves` exists to prevent, arriving through the
    // stopping rule instead of the selection: the first ten eligible rows are
    // all notes, so the batch fills, and the reserved type is never read at
    // all. `selectReviewBatch` can only allocate out of what it is given.
    const store = new MemoryAssuranceStore();
    for (let i = 0; i < 30; i += 1) {
      const type = i < 10 ? 'note' : 'record';
      const id = `n${String(i).padStart(4, '0')}`;
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type, id },
        author: actor('user:1'),
        createdAt: age(i),
      });
      store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}`, submittedAt: age(i) });
    }

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
      reserves: [{ targetType: 'record', fraction: 0.2 }],
    });

    expect(result.items).toHaveLength(10);
    expect(result.items.filter((i) => i.target.type === 'record')).toHaveLength(2);
  });

  it('asks for both halves when one type is reserved twice', async () => {
    // The allocator excludes what it has already taken, so two 50% note
    // reserves ask for ten notes between them. Comparing each entry against the
    // type's whole count settled on the first entry's worth — five — and served
    // a batch the allocator would have filled differently.
    const store = new MemoryAssuranceStore();
    for (let i = 0; i < 40; i += 1) {
      // Notes are scarce near the front and plentiful past it, so a run that
      // settles on one entry's worth visibly serves fewer of them.
      const type = i < 5 || i >= 30 ? 'note' : 'record';
      const id = `n${String(i).padStart(4, '0')}`;
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type, id },
        author: actor('user:1'),
        createdAt: age(i),
      });
      store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}`, submittedAt: age(i) });
    }

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
      reserves: [
        { targetType: 'note', fraction: 0.5 },
        { targetType: 'note', fraction: 0.5 },
      ],
    });

    expect(result.items.filter((i) => i.target.type === 'note')).toHaveLength(10);
    expect(result.truncated).toBe(false);
  });

  it('does not settle on a tie at the window boundary', async () => {
    // The boundary guarantee is "every unread proposal was created after the
    // last one read", which at equal timestamps says nothing: an unread row can
    // share the boundary instant and carry a version submitted at it, and the
    // store's tie-break need not match the batch's. Here the eleventh row ties
    // with the tenth and is the one the batch would serve first.
    const store = new MemoryAssuranceStore();
    for (let i = 0; i < 12; i += 1) {
      const id = `n${String(i).padStart(4, '0')}`;
      // Rows 9 and 10 share a creation instant, straddling a window of 10.
      const at = i >= 9 && i <= 10 ? age(9) : age(i);
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type: 'note', id },
        author: actor('user:1'),
        createdAt: at,
      });
      store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}`, submittedAt: at });
    }

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
    });

    // It read past the tie rather than settling on it, so the whole space is
    // accounted for and the batch is the ten oldest of twelve.
    expect(result.items).toHaveLength(10);
    expect(result.examined).toBe(12);
    expect(result.truncated).toBe(false);
  });

  it('settles when reserves overlap, as the allocator does', async () => {
    // Fractions may total more than one — 80% A then 80% B is a legitimate way
    // to say "mostly A, then B" — and `selectReviewBatch` gives the first its
    // eight slots and caps the second at the two left. Demanding both full
    // fractions here scanned to the cap and called a finished batch truncated.
    const store = new MemoryAssuranceStore();
    for (let i = 0; i < 40; i += 1) {
      const type = i % 2 === 0 ? 'note' : 'record';
      const id = `n${String(i).padStart(4, '0')}`;
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type, id },
        author: actor('user:1'),
        createdAt: age(i),
      });
      store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}`, submittedAt: age(i) });
    }

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
      maxCandidateWindow: 20,
      reserves: [
        { targetType: 'note', fraction: 0.8 },
        { targetType: 'record', fraction: 0.8 },
      ],
    });

    expect(result.items).toHaveLength(10);
    expect(result.truncated).toBe(false);
  });

  it('reads no further than the cap when the limit asks for more', async () => {
    // The cap is a bound on the work one request may do, and a caller asking
    // for more rows than it allows is asking for something it forbids. Seeding
    // the window from `limit` alone made the ceiling decorative: a `limit` of
    // 40 read 40 rows on the first pass and never consulted the cap at all,
    // which is the resource bound off by however large the caller's number is.
    const store = backlog(60);
    let widest = 0;
    const list = store.listOpenProposals.bind(store);
    store.listOpenProposals = async (space, query = {}) => {
      widest = Math.max(widest, query.limit ?? Number.POSITIVE_INFINITY);
      return list(space, query);
    };

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 40,
      maxCandidateWindow: 20,
    });

    // The cap plus the one sentinel row that tells an exhausted space from a
    // capped read — never the caller's 40.
    expect(widest).toBe(21);
    // The batch the cap permits, and `truncated` says the search stopped —
    // which is the honest report, not a silently short answer.
    expect(result.items).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  it('ignores a reserve for a type the narrowing has already excluded', async () => {
    // Narrowed to notes and reserving records, the store will never produce a
    // record however far the window grows. Treating that as an unmet reserve
    // means scanning to the cap and reporting `truncated` over a batch that is
    // complete — the flag's own distinction inverted, on a query the caller
    // wrote deliberately.
    const store = new MemoryAssuranceStore();
    for (let i = 0; i < 40; i += 1) {
      const type = i % 4 === 3 ? 'record' : 'note';
      const id = `n${String(i).padStart(4, '0')}`;
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type, id },
        author: actor('user:1'),
        createdAt: age(i),
      });
      store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}`, submittedAt: age(i) });
    }

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
      targetType: 'note',
      maxCandidateWindow: 20,
      reserves: [{ targetType: 'record', fraction: 0.2 }],
    });

    expect(result.items).toHaveLength(10);
    expect(result.items.every((i) => i.target.type === 'note')).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('proves a full batch that exactly fills the window', async () => {
    // The sentinel is read to answer "is there more?" and its instant was
    // thrown away. That cost a whole doubling — and with `limit` equal to the
    // cap there is no doubling left to spend, so a complete batch of the ten
    // oldest rows could certify only nine of them and came back `truncated`,
    // reporting a hidden backlog over work it had provably found.
    const store = backlog(60);

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
      maxCandidateWindow: 10,
    });

    expect(result.items.map((i) => i.target.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `n${String(i).padStart(4, '0')}`),
    );
    expect(result.truncated).toBe(false);
  });

  it('rejects a ceiling that is not a number instead of looping on it', async () => {
    // `NaN` makes every comparison in the loop false — `NaN >= NaN` included,
    // and so is the exhaustion test — so the window grows to `NaN` for ever
    // against a store that answers nothing. Measured before the guard: more
    // than 40 reads against a space holding five rows, with no way out.
    //
    // A malformed numeric config is the caller's bug either way. The
    // difference is between an exception naming the field and a request that
    // never returns, and only one of those can be found from a stack trace.
    const store = backlog(5);

    await expect(
      selectReviewQueueFromStore({
        store,
        space: 's',
        reviewerRef: 'agent:7',
        limit: 10,
        maxCandidateWindow: Number.NaN,
      }),
    ).rejects.toThrow(RangeError);

    await expect(
      selectReviewQueueFromStore({
        store,
        space: 's',
        reviewerRef: 'agent:7',
        limit: Number.NaN,
      }),
    ).rejects.toThrow(RangeError);

    // Both public entry points grow, so both were exposed.
    await expect(
      candidatesFromStore(store, 's', { limit: 10, maxCandidateWindow: Number.NaN }),
    ).rejects.toThrow(RangeError);
  });

  it('rejects a fractional window or batch size', async () => {
    // Both are counts of rows. A fractional window is forwarded as a
    // fractional `LIMIT`, which every store answers differently and a SQL one
    // rejects outright; a fractional limit reaches `slice(0, 0.5)` and returns
    // nothing while the loop believes it settled — a queue that serves an
    // empty batch and calls it complete.
    const store = backlog(5);

    await expect(
      selectReviewQueueFromStore({
        store,
        space: 's',
        reviewerRef: 'agent:7',
        limit: 10,
        maxCandidateWindow: 10.5,
      }),
    ).rejects.toThrow(RangeError);

    await expect(
      selectReviewQueueFromStore({
        store,
        space: 's',
        reviewerRef: 'agent:7',
        limit: 0.5,
      }),
    ).rejects.toThrow(RangeError);

    await expect(
      candidatesFromStore(store, 's', { limit: 2.5 }),
    ).rejects.toThrow(RangeError);
  });

  it('does not serve a revised proposal over an older version it has not read', async () => {
    // The store orders by proposal creation; the batch orders by the current
    // version's submission. A proposal revised after a newer one was submitted
    // carries a version younger than its position suggests, so a full window of
    // recently revised rows can hide an older *version* on a proposal just
    // outside it — and the queue would serve newest-first while claiming the
    // opposite.
    const store = new MemoryAssuranceStore();
    for (let i = 0; i < 10; i += 1) {
      const id = `old${i}`;
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type: 'note', id },
        author: actor('user:1'),
        createdAt: age(i),
      });
      // Created early, revised late: the version is what the queue orders on.
      store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}`, submittedAt: age(100 + i) });
    }
    store.seedProposal({
      proposalId: 'p-untouched',
      target: { space: 's', type: 'note', id: 'untouched' },
      author: actor('user:1'),
      createdAt: age(10),
    });
    store.seedVersion({
      proposalId: 'p-untouched',
      versionId: 'v-untouched',
      submittedAt: age(10),
    });

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
    });

    // The oldest version in the space, and it sat one row past the first window.
    expect(result.items.map((i) => i.target.id)).toContain('untouched');
    expect(result.items[0]!.target.id).toBe('untouched');
  });

  it('counts the final window, not the sum of the re-reads', async () => {
    // `examined` is a diagnostic a host compares against another queue's. A
    // prefix read three times was not three candidates, and reporting it as
    // such would make every parity comparison disagree by the re-read.
    const store = backlog(60);
    await judgeFirst(store, 'agent:7', 10);

    const result = await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
    });

    // The final window, not 10 + 20 summed over the re-reads. It is 20 because
    // the boundary is the sentinel's instant — the oldest row the page did not
    // serve — so the window that first filled the batch can also prove it, and
    // there is no third doubling to sum.
    expect(result.examined).toBe(20);
    expect(result.excluded).toHaveLength(10);
  });
});

describe('both growing loops hydrate each proposal once', () => {
  // The property, not an arithmetic bound on a fixture: every `latestVersion`
  // is for a proposal not asked about before. Each growth re-reads the prefix,
  // so without a cache shared across the whole call a run to the cap costs
  // 100 + 200 + 400 + … sequential round trips against a store built for real
  // latency.
  //
  // Asserted for both loops because they have twice needed the same fix and
  // received it once — the cache first, then the window clamp — each shipping
  // as its own defect a few lines from a loop that already did it right.
  const age = (i: number): string =>
    `2020-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`;

  /** 400 proposals, only every fifth submitted, so the window has to grow far. */
  function sparse(): { store: MemoryAssuranceStore; asked: string[] } {
    const store = new MemoryAssuranceStore();
    for (let i = 0; i < 400; i += 1) {
      const id = `n${String(i).padStart(4, '0')}`;
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type: 'note', id },
        author: actor('user:1'),
        createdAt: age(i),
      });
      // No version row at all for the rest — `latestVersion` returns null for
      // them, which is the case a `??`-based cache treats as a miss forever.
      if (i % 5 === 0) {
        store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}`, submittedAt: age(i) });
      }
    }
    const asked: string[] = [];
    const latest = store.latestVersion.bind(store);
    store.latestVersion = async (proposalId) => {
      asked.push(proposalId);
      return latest(proposalId);
    };
    return { store, asked };
  }

  it('when growing to fill a candidate count', async () => {
    const { store, asked } = sparse();
    await candidatesFromStore(store, 's', { limit: 50 });
    expect(asked).toHaveLength(new Set(asked).size);
  });

  it('when growing to settle a batch', async () => {
    const { store, asked } = sparse();
    await selectReviewQueueFromStore({
      store,
      space: 's',
      reviewerRef: 'agent:7',
      limit: 10,
    });
    expect(asked).toHaveLength(new Set(asked).size);
  });
});

describe('candidatesFromStore — limit counts candidates, not rows read', () => {
  it('fills the count past proposals with no submitted version', async () => {
    // Unsubmitted proposals are dropped after the store's limit, so asking for
    // three and reading three returned one. A host cannot tell that short page
    // from an exhausted backlog.
    const store = new MemoryAssuranceStore();
    for (let i = 0; i < 10; i += 1) {
      const id = `n${i}`;
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type: 'note', id },
        author: actor('user:1'),
        createdAt: T(i + 1),
      });
      // Every third one is submitted; the rest are drafts with no version to
      // show. Submitted at its own proposal's instant, never before it: the
      // store refuses a backdated submission, and the queue's early stop is
      // the reason.
      store.seedVersion({
        proposalId: `p-${id}`,
        versionId: `v-${id}`,
        ...(i % 3 === 0 ? { submittedAt: T(i + 1) } : { submittedAt: null }),
      });
    }

    const candidates = await candidatesFromStore(store, 's', { limit: 3 });
    expect(candidates.map((c) => c.target.id)).toEqual(['n0', 'n3', 'n6']);
  });

  it('reads no further than the cap when the count asks for more', async () => {
    // The other growing loop, with the same defect the selector had: seeding
    // the window from `limit` meant a caller could step over the ceiling just
    // by asking for more than it allows, and the first read went straight past
    // it before the cap was ever consulted.
    const store = new MemoryAssuranceStore();
    for (let i = 0; i < 60; i += 1) {
      const id = `n${String(i).padStart(4, '0')}`;
      store.seedProposal({
        proposalId: `p-${id}`,
        target: { space: 's', type: 'note', id },
        author: actor('user:1'),
        createdAt: T(1),
      });
      store.seedVersion({ proposalId: `p-${id}`, versionId: `v-${id}`, submittedAt: T(1) });
    }
    let widest = 0;
    const list = store.listOpenProposals.bind(store);
    store.listOpenProposals = async (space, query = {}) => {
      widest = Math.max(widest, query.limit ?? Number.POSITIVE_INFINITY);
      return list(space, query);
    };

    const candidates = await candidatesFromStore(store, 's', {
      limit: 40,
      maxCandidateWindow: 20,
    });

    // The cap plus the one sentinel row, never the caller's 40.
    expect(widest).toBe(21);
    expect(candidates).toHaveLength(20);
  });

  it('returns what there is when the space runs out first', async () => {
    const store = new MemoryAssuranceStore();
    store.seedProposal({
      proposalId: 'p-n0',
      target: { space: 's', type: 'note', id: 'n0' },
      author: actor('user:1'),
      createdAt: T(1),
    });
    store.seedVersion({ proposalId: 'p-n0', versionId: 'v-n0', submittedAt: T(1) });

    expect(await candidatesFromStore(store, 's', { limit: 5 })).toHaveLength(1);
  });
});
