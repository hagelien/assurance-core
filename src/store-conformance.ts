/**
 * The executable contract for `AssuranceStore`.
 *
 * An interface written in TypeScript states the shapes and nothing else. It
 * cannot say that `currentAssessments` returns one row per assessor, that
 * `listOpenProposals` is oldest-first, or that a ruling closes a dispute — and
 * those are exactly the properties the core relies on. A host whose adapter
 * type-checks can still be wrong in every one of them, and the failure will
 * surface as a review that quietly counts a reviewer twice.
 *
 * So the contract is executable, and any host can run it against its own
 * implementation.
 *
 * ## Why this returns results instead of asserting
 *
 * Because a test framework is a dependency, and this package has none. A
 * conformance suite written in one framework's assertions would either drag it
 * into every consumer's install or restrict the port to hosts that happened to
 * pick the same one. `runStoreConformance` returns a plain list of outcomes;
 * the host asserts on it in whatever it already uses, in one line.
 *
 * ## Why a host supplies the seeding
 *
 * The port has no way to create a proposal, on purpose — that is a host act
 * over domain content. So the suite cannot construct its own fixtures and does
 * not try: the harness makes the rows, and the suite exercises what governance
 * is allowed to do with them afterwards. This is a little more work for the
 * host and is the only shape that does not require weakening the interface to
 * make its own test suite convenient.
 */

import type { ActorSnapshot } from './actors.js';
import type { EvidenceRequirementState } from './assurance.js';
import type { RiskProfile } from './risk.js';
import type { ProposalVersionRef, TargetRef } from './types.js';
import type { AssuranceStore, Timestamp } from './store.js';
import { formatVersionRef } from './store.js';

/** What the suite asks a host to create before each check. */
export interface ConformanceSeed {
  proposal(input: {
    proposalId: string;
    target: TargetRef;
    author: ActorSnapshot;
    createdAt: Timestamp;
    open?: boolean;
  }): Promise<void>;
  version(input: {
    proposalId: string;
    versionId: string;
    risk?: RiskProfile;
    submittedAt?: Timestamp | null;
  }): Promise<void>;
  evidence(
    ref: ProposalVersionRef,
    state: readonly EvidenceRequirementState[],
  ): Promise<void>;
}

export interface ConformanceHarness {
  readonly store: AssuranceStore;
  readonly seed: ConformanceSeed;
}

export interface ConformanceResult {
  readonly name: string;
  readonly ok: boolean;
  /** Present when `ok` is false: what was expected and what came back. */
  readonly detail?: string;
}

/** Thrown inside a check; caught and turned into a failing result. */
class ContractViolation extends Error {}

function equal(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new ContractViolation(`${what}: expected ${b}, got ${a}`);
  }
}

function truthy(value: unknown, what: string): void {
  if (!value) throw new ContractViolation(`${what}: expected a truthy value`);
}

const SPACE = 'conformance';
const T0 = '2020-01-01T00:00:00.000Z';
const T1 = '2020-01-02T00:00:00.000Z';
const T2 = '2020-01-03T00:00:00.000Z';

const human = (actorRef: string): ActorSnapshot => ({
  actorRef,
  kind: 'human',
  capabilities: [],
  assuranceCapabilities: [],
});
const agent = (actorRef: string): ActorSnapshot => ({
  actorRef,
  kind: 'agent',
  capabilities: [],
  assuranceCapabilities: [],
});

const target = (id: string, type = 'note'): TargetRef => ({
  space: SPACE,
  type,
  id,
});

interface Check {
  readonly name: string;
  run(h: ConformanceHarness): Promise<void>;
}

const CHECKS: readonly Check[] = [
  {
    name: 'a seeded proposal reads back with its target and author',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const found = await store.getProposal('p1');
      truthy(found, 'getProposal returned null for a seeded proposal');
      equal(found!.target, target('n1'), 'proposal target');
      equal(found!.author.actorRef, 'user:1', 'proposal author ref');
      equal(found!.open, true, 'a fresh proposal is open');
    },
  },
  {
    name: 'an unknown proposal or version reads as null, not as a throw',
    async run({ store }) {
      equal(await store.getProposal('nope'), null, 'getProposal(unknown)');
      equal(
        await store.getVersion({ proposalId: 'nope', versionId: 'v1' }),
        null,
        'getVersion(unknown)',
      );
      equal(await store.latestVersion('nope'), null, 'latestVersion(unknown)');
    },
  },
  {
    name: 'open proposals come back oldest first',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'late',
        target: target('n2'),
        author: human('user:1'),
        createdAt: T2,
      });
      await seed.proposal({
        proposalId: 'early',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const open = await store.listOpenProposals(SPACE);
      equal(
        open.map((p) => p.proposalId),
        ['early', 'late'],
        'listOpenProposals order',
      );
    },
  },
  {
    name: 'a closed proposal is not listed as open',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'shut',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
        open: false,
      });
      equal(await store.listOpenProposals(SPACE), [], 'listOpenProposals');
    },
  },
  {
    name: 'listOpenProposals filters by target type, author and limit',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'a',
        target: target('n1', 'note'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.proposal({
        proposalId: 'b',
        target: target('n2', 'record'),
        author: human('user:2'),
        createdAt: T1,
      });
      equal(
        (await store.listOpenProposals(SPACE, { targetType: 'record' })).map(
          (p) => p.proposalId,
        ),
        ['b'],
        'targetType filter',
      );
      equal(
        (
          await store.listOpenProposals(SPACE, { excludeAuthorRef: 'user:1' })
        ).map((p) => p.proposalId),
        ['b'],
        'excludeAuthorRef filter',
      );
      equal(
        (await store.listOpenProposals(SPACE, { limit: 1 })).map(
          (p) => p.proposalId,
        ),
        ['a'],
        'limit',
      );
    },
  },
  {
    name: 'a proposal in another space is not listed',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'elsewhere',
        target: { space: 'other', type: 'note', id: 'n1' },
        author: human('user:1'),
        createdAt: T0,
      });
      equal(await store.listOpenProposals(SPACE), [], 'space scoping');
    },
  },
  {
    name: 'latestVersion returns the highest-numbered version',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.version({ proposalId: 'p1', versionId: 'v1' });
      await seed.version({ proposalId: 'p1', versionId: 'v2' });
      const latest = await store.latestVersion('p1');
      truthy(latest, 'latestVersion returned null');
      equal(latest!.ref.versionId, 'v2', 'latest version id');
      equal(latest!.versionNo > 1, true, 'versionNo increments');
    },
  },
  {
    name: 'a reviewer who revises holds one standing assessment, not two',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.version({ proposalId: 'p1', versionId: 'v1' });
      const ref: ProposalVersionRef = { proposalId: 'p1', versionId: 'v1' };
      const first = await store.recordAssessment({
        version: ref,
        assessorRef: 'user:2',
        assessorKind: 'human',
        verdict: 'dispute',
        recordedAt: T0,
      });
      await store.recordAssessment({
        version: ref,
        assessorRef: 'user:2',
        assessorKind: 'human',
        verdict: 'approve',
        supersedesAssessmentId: first.assessmentId,
        recordedAt: T1,
      });
      const standing = await store.currentAssessments(ref);
      equal(standing.length, 1, 'standing assessment count');
      equal(standing[0]!.verdict, 'approve', 'the surviving verdict');
    },
  },
  {
    name: 'assessments are scoped to the version they were cast against',
    async run({ store, seed }) {
      // The property that keeps a revision from inheriting an earlier
      // version's approvals — the single most consequential thing this port
      // asks a host to get right.
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.version({ proposalId: 'p1', versionId: 'v1' });
      await seed.version({ proposalId: 'p1', versionId: 'v2' });
      await store.recordAssessment({
        version: { proposalId: 'p1', versionId: 'v1' },
        assessorRef: 'user:2',
        assessorKind: 'human',
        verdict: 'approve',
        recordedAt: T0,
      });
      equal(
        (await store.currentAssessments({ proposalId: 'p1', versionId: 'v2' }))
          .length,
        0,
        'assessments leaking onto a later version',
      );
      equal(
        (await store.currentAssessments({ proposalId: 'p1', versionId: 'v1' }))
          .length,
        1,
        'assessments on the version they were cast against',
      );
    },
  },
  {
    name: 'the capability snapshot survives the round trip',
    async run({ store, seed }) {
      // A verdict admitted while a capability was held must keep saying so,
      // and must not start reflecting the assessor's later capabilities.
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.version({ proposalId: 'p1', versionId: 'v1' });
      const ref: ProposalVersionRef = { proposalId: 'p1', versionId: 'v1' };
      await store.recordAssessment({
        version: ref,
        assessorRef: 'agent:7',
        assessorKind: 'agent',
        verdict: 'approve',
        assuranceCapabilities: ['model_tier:flagship'],
        recordedAt: T0,
      });
      const [stored] = await store.currentAssessments(ref);
      truthy(stored, 'no assessment came back');
      equal(
        stored!.assuranceCapabilities,
        ['model_tier:flagship'],
        'capability snapshot',
      );
    },
  },
  {
    name: 'assessmentsByActor answers for many versions at once',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.proposal({
        proposalId: 'p2',
        target: target('n2'),
        author: human('user:1'),
        createdAt: T1,
      });
      await seed.version({ proposalId: 'p1', versionId: 'v1' });
      await seed.version({ proposalId: 'p2', versionId: 'v1' });
      const a: ProposalVersionRef = { proposalId: 'p1', versionId: 'v1' };
      const b: ProposalVersionRef = { proposalId: 'p2', versionId: 'v1' };
      await store.recordAssessment({
        version: a,
        assessorRef: 'agent:7',
        assessorKind: 'agent',
        verdict: 'approve',
        recordedAt: T0,
      });
      await store.recordAssessment({
        version: b,
        assessorRef: 'agent:8',
        assessorKind: 'agent',
        verdict: 'approve',
        recordedAt: T0,
      });
      const mine = await store.assessmentsByActor('agent:7', [a, b]);
      equal(mine.length, 1, 'assessments for the named actor only');
      equal(formatVersionRef(mine[0]!.version), formatVersionRef(a), 'which version');
    },
  },
  {
    name: 'an implicit assessment is stored as implicit',
    async run({ store, seed }) {
      // An author's submit-time stake is evidence of authorship, not of
      // review. A store that dropped the flag would let it count toward a
      // quorum.
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.version({ proposalId: 'p1', versionId: 'v1' });
      const ref: ProposalVersionRef = { proposalId: 'p1', versionId: 'v1' };
      await store.recordAssessment({
        version: ref,
        assessorRef: 'user:1',
        assessorKind: 'human',
        verdict: 'approve',
        implicit: true,
        recordedAt: T0,
      });
      const [stored] = await store.currentAssessments(ref);
      equal(stored!.implicit, true, 'implicit flag');
    },
  },
  {
    name: 'a dispute is open until ruled on, and closed after',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.version({ proposalId: 'p1', versionId: 'v1' });
      const ref: ProposalVersionRef = { proposalId: 'p1', versionId: 'v1' };
      const dispute = await store.openDispute({
        version: ref,
        openedByRef: 'user:2',
        openedByKind: 'human',
        openedAt: T0,
      });
      equal((await store.disputes(ref))[0]!.open, true, 'dispute starts open');
      await store.ruleDispute({
        disputeId: dispute.disputeId,
        ruling: 'rejected',
        ruledByRef: 'user:3',
        ruledAt: T1,
      });
      equal((await store.disputes(ref))[0]!.open, false, 'dispute after a ruling');
      equal(
        (await store.disputeRulings(dispute.disputeId)).length,
        1,
        'ruling count',
      );
    },
  },
  {
    name: 'latestDecision returns the most recent evaluation',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.version({ proposalId: 'p1', versionId: 'v1' });
      const ref: ProposalVersionRef = { proposalId: 'p1', versionId: 'v1' };
      equal(await store.latestDecision(ref), null, 'no decision yet');
      await store.recordDecision({
        version: ref,
        policyId: 'p',
        policyVersion: '1',
        allowed: false,
        inputFingerprint: 'f1',
        mode: 'shadow',
        evaluatedAt: T0,
      });
      await store.recordDecision({
        version: ref,
        policyId: 'p',
        policyVersion: '1',
        allowed: true,
        inputFingerprint: 'f2',
        mode: 'authoritative',
        evaluatedAt: T1,
      });
      const latest = await store.latestDecision(ref);
      equal(latest!.allowed, true, 'latest decision outcome');
      equal(latest!.mode, 'authoritative', 'latest decision mode');
    },
  },
  {
    name: 'evidence state round-trips as the host declared it',
    async run({ store, seed }) {
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.version({ proposalId: 'p1', versionId: 'v1' });
      const ref: ProposalVersionRef = { proposalId: 'p1', versionId: 'v1' };
      equal(await store.evidenceState(ref), [], 'no evidence declared');
      await seed.evidence(ref, [{ requirementId: 'cited', satisfied: false }]);
      equal(
        await store.evidenceState(ref),
        [{ requirementId: 'cited', satisfied: false }],
        'declared evidence state',
      );
    },
  },
  {
    name: 'an agent author is stored as an agent, not flattened to a human',
    async run({ store, seed }) {
      // Author kind drives rules that exist precisely to treat the two
      // differently. A store that lost it would make those rules unreachable.
      await seed.proposal({
        proposalId: 'p1',
        target: target('n1'),
        author: agent('agent:7'),
        createdAt: T0,
      });
      const found = await store.getProposal('p1');
      equal(found!.author.kind, 'agent', 'author kind');
    },
  },
];

/**
 * Run the contract against a host's implementation.
 *
 * `makeHarness` is called once per check and must return a store with no prior
 * state: checks seed conflicting fixtures under the same ids on purpose, so
 * that a host which cannot actually isolate them finds out here rather than in
 * a flaky suite of its own.
 */
export async function runStoreConformance(
  makeHarness: () => Promise<ConformanceHarness> | ConformanceHarness,
): Promise<readonly ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const check of CHECKS) {
    try {
      const harness = await makeHarness();
      await check.run(harness);
      results.push({ name: check.name, ok: true });
    } catch (error) {
      results.push({
        name: check.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** The names of every check, for a host that wants one test case per contract clause. */
export const STORE_CONFORMANCE_CHECKS: readonly string[] = CHECKS.map(
  (c) => c.name,
);

/** Every failure, formatted for an assertion message. Empty means conforming. */
export function conformanceFailures(
  results: readonly ConformanceResult[],
): readonly string[] {
  return results
    .filter((r) => !r.ok)
    .map((r) => `${r.name} — ${r.detail ?? 'failed'}`);
}
