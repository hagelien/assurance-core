/**
 * The persistence port, checked two ways.
 *
 * First: the reference implementation is run through the executable contract
 * it exists to define. That is a circular-looking arrangement and it is the
 * point — if `MemoryAssuranceStore` and `runStoreConformance` are allowed to
 * drift, a host that passes conformance still has no idea what the core will
 * do with its data, because the core's own examples run against the other one.
 *
 * Second: the contract is checked for *teeth*. A conformance suite that passes
 * for a store which quietly gets things wrong is worse than none, since it
 * converts an unexamined risk into a documented guarantee. So deliberately
 * broken stores are run through it, and each must fail on the clause it
 * breaks.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryAssuranceStore,
  conformanceFailures,
  memoryStore,
  runStoreConformance,
  toAssessment,
  type ConformanceHarness,
  type ProposalVersionRef,
  type StoredAssessment,
} from '../src/index.js';
import { STORE_CONFORMANCE_CHECKS } from '../src/store-conformance.js';

/** Wrap a memory store in the harness shape the suite asks for. */
function harnessFor(store: MemoryAssuranceStore): ConformanceHarness {
  return {
    store,
    // The reference store has no domain, so it declares whatever the checks
    // need — including the second space and type a real single-collection host
    // cannot offer. That is why the ADR host is also run: this harness can
    // never exercise the skip path.
    space: 'conformance',
    targetType: 'note',
    otherSpace: 'other',
    otherTargetType: 'record',
    seed: {
      // The ids come back from the store, never down into it: see
      // `ConformanceSeed`. The reference store assigns them the way a host's
      // sequence would.
      async proposal(input) {
        const created = store.seedProposal(input);
        return { proposalId: created.proposalId, target: created.target };
      },
      async version(input) {
        return { ref: store.seedVersion(input).ref };
      },
      async evidence(ref, state) {
        store.seedEvidence(ref, state);
      },
    },
  };
}

describe('the reference store satisfies the contract', () => {
  it('passes every conformance check', async () => {
    const results = await runStoreConformance(() =>
      harnessFor(new MemoryAssuranceStore()),
    );
    expect(conformanceFailures(results)).toEqual([]);
    // Non-vacuity: an empty suite reports no failures either.
    expect(results.length).toBe(STORE_CONFORMANCE_CHECKS.length);
    expect(results.length).toBeGreaterThan(12);
  });

  it('gives each check a fresh store', async () => {
    // Checks seed conflicting fixtures under the same ids. A harness factory
    // that handed out one shared store would make them interfere, and this is
    // the assertion that would notice.
    const seen = new Set<unknown>();
    await runStoreConformance(() => {
      const store = new MemoryAssuranceStore();
      seen.add(store);
      return harnessFor(store);
    });
    expect(seen.size).toBe(STORE_CONFORMANCE_CHECKS.length);
  });
});

describe('the contract has teeth', () => {
  /**
   * Each entry breaks exactly one promise the port makes, and names the check
   * that must catch it. A broken store that still passed would mean the clause
   * is documentation rather than a contract.
   */
  const BREAKAGES: ReadonlyArray<{
    what: string;
    catchesContaining: string;
    break: (store: MemoryAssuranceStore) => void;
  }> = [
    {
      what: 'returns every assessment, including superseded ones',
      catchesContaining: 'revises holds one standing assessment',
      break(store) {
        // The realistic bug: reading the raw history and calling it current.
        (store as unknown as {
          standing: (p: readonly StoredAssessment[]) => StoredAssessment[];
        }).standing = (pool) => [...pool];
      },
    },
    {
      what: 'ignores the version an assessment was cast against',
      catchesContaining: 'scoped to the version',
      break(store) {
        const all = store.currentAssessments.bind(store);
        store.currentAssessments = async (ref: ProposalVersionRef) => {
          // Proposal-scoped instead of version-scoped: the mistake that lets a
          // revision inherit the previous version's approvals.
          const dump = store.dump();
          const anyOnProposal = dump.assessments.filter(
            (a) => a.version.proposalId === ref.proposalId,
          );
          return anyOnProposal.length > 0 ? anyOnProposal : all(ref);
        };
      },
    },
    {
      what: 'drops the capability snapshot',
      catchesContaining: 'capability snapshot survives',
      break(store) {
        const record = store.recordAssessment.bind(store);
        store.recordAssessment = async (input) => {
          const { assuranceCapabilities: _dropped, ...rest } = input;
          return record(rest);
        };
      },
    },
    {
      what: 'lists proposals newest first',
      catchesContaining: 'oldest first',
      break(store) {
        const list = store.listOpenProposals.bind(store);
        store.listOpenProposals = async (space, query) =>
          [...(await list(space, query))].reverse();
      },
    },
    {
      what: 'leaves a dispute open after it has been ruled on',
      catchesContaining: 'open until ruled on',
      break(store) {
        // A store that holds `open` as its own column and forgets to clear it
        // when a ruling lands — the flag and the history disagreeing, which is
        // exactly the case the port says the history wins.
        const list = store.disputes.bind(store);
        store.disputes = async (ref) =>
          (await list(ref)).map((d) => ({ ...d, open: true }));
      },
    },
    {
      what: 'ignores the space a proposal belongs to',
      catchesContaining: 'another space',
      break(store) {
        const list = store.listOpenProposals.bind(store);
        store.listOpenProposals = async (_space, query) =>
          list('other', query).then((rows) =>
            rows.length > 0 ? rows : list(_space, query),
          );
      },
    },
    {
      what: 'flattens an agent author into a human one',
      catchesContaining: 'agent author is stored as an agent',
      break(store) {
        const get = store.getProposal.bind(store);
        store.getProposal = async (id) => {
          const found = await get(id);
          return found
            ? { ...found, author: { ...found.author, kind: 'human' as const } }
            : null;
        };
      },
    },
  ];

  it.each(BREAKAGES)('catches a store that $what', async (breakage) => {
    const results = await runStoreConformance(() => {
      const store = new MemoryAssuranceStore();
      breakage.break(store);
      return harnessFor(store);
    });
    const failures = conformanceFailures(results);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some((f) => f.includes(breakage.catchesContaining)),
      `expected a failure mentioning "${breakage.catchesContaining}", got:\n${failures.join('\n')}`,
    ).toBe(true);
  });
});

describe('toAssessment', () => {
  it('hands the tally distinct assessors and nothing per-row', async () => {
    // `tallyAssurance` counts distinct assessors. Passing it a record that
    // carries an id and a timestamp is how a reviewer who revised a verdict
    // starts counting twice, so the projection drops them.
    const store = memoryStore();
    store.seedProposal({
      proposalId: 'p1',
      target: { space: 's', type: 'note', id: 'n1' },
      author: {
        actorRef: 'user:1',
        kind: 'human',
        capabilities: [],
        assuranceCapabilities: [],
      },
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    store.seedVersion({ proposalId: 'p1', versionId: 'v1' });
    const stored = await store.recordAssessment({
      version: { proposalId: 'p1', versionId: 'v1' },
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'approve',
      assuranceCapabilities: ['model_tier:flagship'],
      recordedAt: '2020-01-01T00:00:00.000Z',
    });

    expect(toAssessment(stored)).toEqual({
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'approve',
      implicit: false,
      assuranceCapabilities: ['model_tier:flagship'],
    });
    expect(Object.keys(toAssessment(stored))).not.toContain('assessmentId');
    expect(Object.keys(toAssessment(stored))).not.toContain('recordedAt');
  });

  it('omits the capability key entirely when none was recorded', () => {
    // Not `assuranceCapabilities: []`. The tally fingerprints its input, and
    // an absent key and an empty array must not produce two fingerprints for
    // the same governance state.
    const bare = toAssessment({
      assessmentId: 'a1',
      version: { proposalId: 'p1', versionId: 'v1' },
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'approve',
      implicit: false,
      supersedesAssessmentId: null,
      recordedAt: '2020-01-01T00:00:00.000Z',
    });
    expect('assuranceCapabilities' in bare).toBe(false);
  });
});

describe('the port refuses what belongs to the host', () => {
  it('offers no way to create a proposal, append a version, or publish', () => {
    // Enforcement by absence, the same way the append-only rule is enforced.
    // A host that wants to do any of these has to reach past the port, which
    // is visible in review rather than silently available.
    const store: Record<string, unknown> = memoryStore() as never;
    const surface = new Set<string>();
    let proto: object | null = Object.getPrototypeOf(store) as object | null;
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) surface.add(name);
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    // Seeding exists on the reference store and is deliberately NOT on
    // `AssuranceStore`; the check is that nothing on the interface itself
    // does these, which is why the forbidden names are the interface's
    // vocabulary and not `seedProposal`.
    for (const forbidden of [
      'createProposal',
      'appendVersion',
      'publish',
      'applyVersion',
      'setProposalState',
      'deleteAssessment',
      'updateAssessment',
    ]) {
      expect(surface.has(forbidden), `store exposes ${forbidden}`).toBe(false);
    }
    // Non-vacuity: the reflection above really did find the surface.
    expect(surface.has('recordAssessment')).toBe(true);
    expect(surface.has('currentAssessments')).toBe(true);
  });
});
