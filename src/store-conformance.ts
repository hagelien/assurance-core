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
import type {
  ProposalVersionRef,
  SpaceId,
  TargetRef,
  TargetType,
} from './types.js';
import type { AssuranceStore, Timestamp } from './store.js';

/**
 * What the suite asks a host to create before each check.
 *
 * Both creators **return the identifiers the host assigned**, and do not
 * accept them. That is not a stylistic choice: a host's ids come from its own
 * store — a sequence, a UUID column, a natural key — and a suite that handed
 * down `p1` and `v1` would only be runnable by a host willing to accept
 * foreign ids for rows it creates. The first real adapter written against this
 * suite could not, which is how the requirement was found.
 *
 * The same applies to the target. The `target` passed to `proposal` says which
 * governed object is meant; the one returned says which the host actually
 * used, and they can differ — a host with one collection normalises the space
 * and type, and a host whose targets are integer-keyed will not keep the id it
 * was handed. Checks compare against what came back.
 */
export interface ConformanceSeed {
  proposal(input: {
    target: TargetRef;
    author: ActorSnapshot;
    createdAt: Timestamp;
    open?: boolean;
  }): Promise<{ proposalId: string; target: TargetRef }>;
  version(input: {
    proposalId: string;
    risk?: RiskProfile;
    submittedAt?: Timestamp | null;
  }): Promise<{ ref: ProposalVersionRef }>;
  evidence(
    ref: ProposalVersionRef,
    state: readonly EvidenceRequirementState[],
  ): Promise<void>;
}

export interface ConformanceHarness {
  readonly store: AssuranceStore;
  readonly seed: ConformanceSeed;
  /**
   * The space the harness seeds into.
   *
   * Declared rather than dictated, for the same reason ids are: a host runs
   * the spaces it runs, and one that governs a single collection cannot be
   * asked to invent a second on request.
   */
  readonly space: SpaceId;
  /** The target type the harness seeds. */
  readonly targetType: TargetType;
  /**
   * A second space, when the host has one. Absent means the space-scoping
   * check is **skipped and reported as skipped** — never quietly passed.
   * A host that governs one collection genuinely cannot demonstrate that
   * listing is scoped, and saying so is more useful than a green tick that
   * means nothing.
   */
  readonly otherSpace?: SpaceId;
  /** A second target type, when the host has one. Absent skips the type filter. */
  readonly otherTargetType?: TargetType;
}

export interface ConformanceResult {
  readonly name: string;
  readonly ok: boolean;
  /**
   * True when the harness cannot express what the check needs — a single-space
   * host asked to prove space scoping, say.
   *
   * A skip is not a pass and is not counted as one. It is surfaced separately
   * so a host can see exactly which clauses its shape leaves unverified, and
   * decide whether that is acceptable, rather than reading a green run as full
   * coverage.
   */
  readonly skipped?: boolean;
  /** Why it failed, or why it was skipped. */
  readonly detail?: string;
}

/** Thrown by a check the harness cannot express. Reported as a skip. */
class NotApplicable extends Error {}

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

const T0 = '2020-01-01T00:00:00.000Z';
const T1 = '2020-01-02T00:00:00.000Z';
const T2 = '2020-01-03T00:00:00.000Z';

/**
 * An identifier no host would have issued.
 *
 * Deliberately not `'1'` or `'p1'`: those are plausible keys in an
 * integer-keyed store, and a check for "an unknown id reads as null" that
 * happened to name a real row would pass for the wrong reason.
 */
const UNKNOWN = '__conformance_no_such_id__';

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

/** A target in the harness's own space and type. */
const target = (h: ConformanceHarness, id: string, type?: TargetType): TargetRef => ({
  space: h.space,
  type: type ?? h.targetType,
  id,
});

interface Check {
  readonly name: string;
  run(h: ConformanceHarness): Promise<void>;
}

const CHECKS: readonly Check[] = [
  {
    name: 'a seeded proposal reads back with its target and author',
    async run(h) {
      const { store, seed } = h;
      const created = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const found = await store.getProposal(created.proposalId);
      truthy(found, 'getProposal returned null for a seeded proposal');
      equal(found!.target, created.target, 'proposal target');
      // Whatever the host normalised the target to, it must be in the space
      // the harness declared — otherwise every listing check below is asking
      // about a space nothing was seeded into.
      equal(found!.target.space, h.space, 'proposal space');
      equal(found!.author.actorRef, 'user:1', 'proposal author ref');
      equal(found!.open, true, 'a fresh proposal is open');
    },
  },
  {
    name: 'an unknown proposal or version reads as null, not as a throw',
    async run(h) {
      const { store } = h;
      // An id no host would have issued. A store that threw here would make
      // every "does this exist?" call site carry a try/catch.
      equal(await store.getProposal(UNKNOWN), null, 'getProposal(unknown)');
      equal(
        await store.getVersion({ proposalId: UNKNOWN, versionId: UNKNOWN }),
        null,
        'getVersion(unknown)',
      );
      equal(await store.latestVersion(UNKNOWN), null, 'latestVersion(unknown)');
    },
  },
  {
    name: 'open proposals come back oldest first',
    async run(h) {
      const { store, seed } = h;
      const late = await seed.proposal({
        target: target(h, 'n2'),
        author: human('user:1'),
        createdAt: T2,
      });
      const early = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const open = await store.listOpenProposals(h.space);
      equal(
        open.map((p) => p.proposalId),
        [early.proposalId, late.proposalId],
        'listOpenProposals order',
      );
    },
  },
  {
    name: 'a closed proposal is not listed as open',
    async run(h) {
      const { store, seed } = h;
      await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
        open: false,
      });
      equal(await store.listOpenProposals(h.space), [], 'listOpenProposals');
    },
  },
  {
    name: 'listOpenProposals excludes an author on request',
    async run(h) {
      const { store, seed } = h;
      await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const other = await seed.proposal({
        target: target(h, 'n2'),
        author: human('user:2'),
        createdAt: T1,
      });
      equal(
        (
          await store.listOpenProposals(h.space, { excludeAuthorRef: 'user:1' })
        ).map((p) => p.proposalId),
        [other.proposalId],
        'excludeAuthorRef filter',
      );
    },
  },
  {
    name: 'listOpenProposals honours a limit, keeping the oldest',
    async run(h) {
      const { store, seed } = h;
      const first = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.proposal({
        target: target(h, 'n2'),
        author: human('user:2'),
        createdAt: T1,
      });
      // Which one survives the limit matters: a store that truncated a
      // newest-first ordering would serve a queue that never reaches its own
      // backlog, and the row count would look identical.
      equal(
        (await store.listOpenProposals(h.space, { limit: 1 })).map(
          (p) => p.proposalId,
        ),
        [first.proposalId],
        'limit',
      );
    },
  },
  {
    name: 'listOpenProposals filters by target type',
    async run(h) {
      const { store, seed } = h;
      if (!h.otherTargetType) {
        throw new NotApplicable(
          'the harness declares one target type, so a type filter cannot be observed',
        );
      }
      await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const other = await seed.proposal({
        target: target(h, 'n2', h.otherTargetType),
        author: human('user:2'),
        createdAt: T1,
      });
      equal(other.target.type, h.otherTargetType, 'the host used the second type');
      equal(
        (
          await store.listOpenProposals(h.space, {
            targetType: h.otherTargetType,
          })
        ).map((p) => p.proposalId),
        [other.proposalId],
        'targetType filter',
      );
    },
  },
  {
    name: 'a proposal in another space is not listed',
    async run(h) {
      const { store, seed } = h;
      if (!h.otherSpace) {
        throw new NotApplicable(
          'the harness governs a single space, so scoping cannot be observed',
        );
      }
      await seed.proposal({
        target: { space: h.otherSpace, type: h.targetType, id: 'n1' },
        author: human('user:1'),
        createdAt: T0,
      });
      equal(await store.listOpenProposals(h.space), [], 'space scoping');
    },
  },
  {
    name: 'latestVersion returns the most recently appended version',
    async run(h) {
      const { store, seed } = h;
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      await seed.version({ proposalId });
      const second = await seed.version({ proposalId });
      const latest = await store.latestVersion(proposalId);
      truthy(latest, 'latestVersion returned null');
      equal(latest!.ref, second.ref, 'latest version ref');
      equal(latest!.versionNo > 1, true, 'versionNo increments');
    },
  },
  {
    name: 'a reviewer who revises holds one standing assessment, not two',
    async run(h) {
      const { store, seed } = h;
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const { ref } = await seed.version({ proposalId });
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
    async run(h) {
      const { store, seed } = h;
      // The property that keeps a revision from inheriting an earlier
      // version's approvals — the single most consequential thing this port
      // asks a host to get right.
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const first = await seed.version({ proposalId });
      const second = await seed.version({ proposalId });
      await store.recordAssessment({
        version: first.ref,
        assessorRef: 'user:2',
        assessorKind: 'human',
        verdict: 'approve',
        recordedAt: T0,
      });
      equal(
        (await store.currentAssessments(second.ref)).length,
        0,
        'assessments leaking onto a later version',
      );
      equal(
        (await store.currentAssessments(first.ref)).length,
        1,
        'assessments on the version they were cast against',
      );
    },
  },
  {
    name: 'the capability snapshot survives the round trip',
    async run(h) {
      const { store, seed } = h;
      // A verdict admitted while a capability was held must keep saying so,
      // and must not start reflecting the assessor's later capabilities.
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const { ref } = await seed.version({ proposalId });
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
    async run(h) {
      const { store, seed } = h;
      const one = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const two = await seed.proposal({
        target: target(h, 'n2'),
        author: human('user:1'),
        createdAt: T1,
      });
      const a = await seed.version({ proposalId: one.proposalId });
      const b = await seed.version({ proposalId: two.proposalId });
      await store.recordAssessment({
        version: a.ref,
        assessorRef: 'agent:7',
        assessorKind: 'agent',
        verdict: 'approve',
        recordedAt: T0,
      });
      await store.recordAssessment({
        version: b.ref,
        assessorRef: 'agent:8',
        assessorKind: 'agent',
        verdict: 'approve',
        recordedAt: T0,
      });
      const mine = await store.assessmentsByActor('agent:7', [a.ref, b.ref]);
      equal(mine.length, 1, 'assessments for the named actor only');
      equal(mine[0]!.version, a.ref, 'which version');
    },
  },
  {
    name: 'an implicit assessment is stored as implicit',
    async run(h) {
      const { store, seed } = h;
      // An author's submit-time stake is evidence of authorship, not of
      // review. A store that dropped the flag would let it count toward a
      // quorum.
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const { ref } = await seed.version({ proposalId });
      await store.recordAssessment({
        version: ref,
        assessorRef: 'user:1',
        assessorKind: 'human',
        verdict: 'approve',
        implicit: true,
        recordedAt: T0,
      });
      const [stored] = await store.currentAssessments(ref);
      truthy(stored, 'no assessment came back');
      equal(stored!.implicit, true, 'implicit flag');
    },
  },
  {
    name: 'a dispute is open until ruled on, and closed after',
    async run(h) {
      const { store, seed } = h;
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const { ref } = await seed.version({ proposalId });
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
    async run(h) {
      const { store, seed } = h;
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const { ref } = await seed.version({ proposalId });
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
      truthy(latest, 'latestDecision returned null after two decisions');
      equal(latest!.allowed, true, 'latest decision outcome');
      equal(latest!.mode, 'authoritative', 'latest decision mode');
    },
  },
  {
    name: 'evidence state round-trips as the host declared it',
    async run(h) {
      const { store, seed } = h;
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const { ref } = await seed.version({ proposalId });
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
    async run(h) {
      const { store, seed } = h;
      // Author kind drives rules that exist precisely to treat the two
      // differently. A store that lost it would make those rules unreachable.
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: agent('agent:7'),
        createdAt: T0,
      });
      const found = await store.getProposal(proposalId);
      truthy(found, 'getProposal returned null');
      equal(found!.author.kind, 'agent', 'author kind');
    },
  },
  {
    name: 'a version carries the risk profile the host classified it with',
    async run(h) {
      const { store, seed } = h;
      // The core cannot judge how consequential a change is; it reads what the
      // host decided. A store that dropped the tags would make every tag rule
      // in every policy unreachable, silently.
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const { ref } = await seed.version({
        proposalId,
        risk: { level: 'high', tags: ['consequential'] },
      });
      const version = await store.getVersion(ref);
      truthy(version, 'getVersion returned null for a seeded version');
      equal(version!.risk.level, 'high', 'risk level');
    },
  },
  {
    name: 'an unsubmitted version says so rather than looking reviewable',
    async run(h) {
      const { store, seed } = h;
      // A draft nobody has submitted must not reach a review queue. The queue
      // reads `submittedAt`, so a store that stamped one anyway would put
      // unfinished work in front of reviewers.
      const { proposalId } = await seed.proposal({
        target: target(h, 'n1'),
        author: human('user:1'),
        createdAt: T0,
      });
      const { ref } = await seed.version({ proposalId, submittedAt: null });
      const version = await store.getVersion(ref);
      truthy(version, 'getVersion returned null');
      equal(version!.submittedAt, null, 'submittedAt on an unsubmitted version');
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
      if (error instanceof NotApplicable) {
        // Not a pass. `conformanceFailures` ignores it and
        // `conformanceSkipped` names it, so a host sees which clauses its own
        // shape leaves unverified instead of reading a green run as full
        // coverage.
        results.push({
          name: check.name,
          ok: false,
          skipped: true,
          detail: error.message,
        });
        continue;
      }
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
    .filter((r) => !r.ok && !r.skipped)
    .map((r) => `${r.name} — ${r.detail ?? 'failed'}`);
}

/**
 * Clauses the harness could not express, and why.
 *
 * Worth asserting on rather than ignoring: a host should know which parts of
 * the contract its own shape leaves unchecked, and a skip list that grows
 * without anyone noticing is how a conformance run stops meaning anything.
 */
export function conformanceSkipped(
  results: readonly ConformanceResult[],
): readonly string[] {
  return results
    .filter((r) => r.skipped)
    .map((r) => `${r.name} — ${r.detail ?? 'not applicable'}`);
}
