/**
 * Assurance state: what review a proposal version has actually accumulated.
 *
 * The core deliberately has **no universal score**. A host that shows readers
 * a 0-3 level, a badge or a sentence is *projecting* this profile, and the
 * projection belongs to the host. Collapsing the profile into one number here
 * would destroy the distinction the profile exists to carry: "two agents
 * agreed but no human looked" and "one high-tier model approved" are not the
 * same state, and no single integer can say both.
 *
 * Everything here is pure and synchronous. Counting is the whole job.
 */

import type { ActorKind, ActorSnapshot } from './actors.js';

/**
 * A reviewer's position on one proposal version. Three verdicts, deliberately:
 * adding a fourth is a governance change for every host at once, not a
 * refactor.
 *
 * `abstain` is a recorded non-position. It proves the reviewer looked and
 * declined to judge, which is not the same as silence, and it never counts
 * toward or against a quorum.
 */
export type AssessmentVerdict = 'approve' | 'dispute' | 'abstain';

/**
 * One recorded assessment. `implicit` marks the stake an author takes by
 * submitting — a host may record an implicit approval at submit time so the
 * author's position is on the record. It is evidence of authorship, not of
 * review, and never counts toward a quorum.
 */
export interface Assessment {
  readonly assessorRef: string;
  readonly assessorKind: ActorKind;
  readonly verdict: AssessmentVerdict;
  readonly implicit: boolean;
  /**
   * Server-owned assurance capabilities the assessor carried **at the time the
   * assessment was recorded**, not the assessor's current ones. The snapshot
   * is what closes the revocation window: a verdict admitted before a tier was
   * revoked must not keep clearing a capability gate afterwards.
   */
  readonly assuranceCapabilities?: readonly string[];
}

/** Whether one evidence requirement the host declared is currently satisfied. */
export interface EvidenceRequirementState {
  readonly requirementId: string;
  readonly satisfied: boolean;
  readonly detail?: string;
}

/** An open or resolved objection against a proposal version. */
export interface DisputeState {
  readonly disputeId: string;
  readonly openedByRef: string;
  readonly openedByKind: ActorKind;
  readonly open: boolean;
}

/**
 * Tallied review state of one proposal version. Counts are over **distinct
 * assessors**: one reviewer that revises its verdict still counts once.
 */
export interface AssuranceProfile {
  /** Distinct assessors with an explicit (non-implicit) `approve`. */
  readonly explicitApprovals: number;
  /** Explicit approvers other than the author. Equals `explicitApprovals` when no author is named. */
  readonly independentApprovers: number;
  /** Distinct explicit approvers whose kind is `human`. */
  readonly humanApprovals: number;
  /** Distinct explicit approvers whose kind is `agent`. */
  readonly agentApprovals: number;
  /** Union of the assurance capabilities carried by explicit approvals, sorted. */
  readonly approvalCapabilities: readonly string[];
  /**
   * Same union, restricted to approvals cast by a `human` assessor. Kept
   * separate because "a human expert signed this off" is not the same claim as
   * "some human approved AND some approver held the expert capability" — the
   * second can be satisfied by two different actors, and a requirement that
   * exists to put a qualified person in the loop must not be satisfiable that
   * way.
   */
  readonly humanApprovalCapabilities: readonly string[];
  /** Distinct assessors with an explicit `dispute` verdict. */
  readonly disputingAssessors: number;
  /** Open dispute records (a separate mechanism from a `dispute` verdict). */
  readonly disputesOpen: number;
  /** Distinct assessors with an explicit `abstain`. */
  readonly abstentions: number;
  /** The author's own submit-time stake, if recorded. Never counts toward quorum. */
  readonly implicitApprovals: number;
  readonly evidenceRequirementState: readonly EvidenceRequirementState[];
}

export const EMPTY_ASSURANCE_PROFILE: AssuranceProfile = Object.freeze({
  explicitApprovals: 0,
  independentApprovers: 0,
  humanApprovals: 0,
  agentApprovals: 0,
  approvalCapabilities: Object.freeze([]) as readonly string[],
  humanApprovalCapabilities: Object.freeze([]) as readonly string[],
  disputingAssessors: 0,
  disputesOpen: 0,
  abstentions: 0,
  implicitApprovals: 0,
  evidenceRequirementState: Object.freeze([]) as readonly EvidenceRequirementState[],
});

export interface TallyOptions {
  /**
   * The proposal author's actor ref. Supplying it splits `independentApprovers`
   * away from `explicitApprovals`; omitting it makes them equal.
   *
   * Omitting it is the right call for a host whose admission rules already
   * guarantee that every explicit approval on record is one the gate is
   * entitled to count — for instance where an author's own explicit verdict
   * can exist only under a grant that also enlarges the reviewer pool (see
   * `reviewerPoolState`), so the verdict is admitted deliberately rather than
   * slipping past a filter here.
   */
  readonly authorRef?: string;
  readonly disputes?: readonly DisputeState[];
  readonly evidenceRequirementState?: readonly EvidenceRequirementState[];
}

/**
 * Reduce raw assessments to a profile. Deterministic: capability output is
 * sorted, and re-tallying the same input always yields an identical object, so
 * the result can be fingerprinted into a decision record.
 *
 * Duplicate assessor refs collapse to one entry, last verdict winning — a
 * reviewer that changed its mind holds one position, not two.
 */
export function tallyAssurance(
  assessments: readonly Assessment[],
  options: TallyOptions = {},
): AssuranceProfile {
  const latestByAssessor = new Map<string, Assessment>();
  let implicitApprovals = 0;
  for (const assessment of assessments) {
    if (assessment.implicit) {
      implicitApprovals += 1;
      continue;
    }
    latestByAssessor.set(assessment.assessorRef, assessment);
  }

  let explicitApprovals = 0;
  let independentApprovers = 0;
  let humanApprovals = 0;
  let agentApprovals = 0;
  let disputingAssessors = 0;
  let abstentions = 0;
  const approvalCapabilities = new Set<string>();
  const humanApprovalCapabilities = new Set<string>();

  for (const assessment of latestByAssessor.values()) {
    if (assessment.verdict === 'dispute') {
      disputingAssessors += 1;
      continue;
    }
    if (assessment.verdict === 'abstain') {
      abstentions += 1;
      continue;
    }
    explicitApprovals += 1;
    if (
      options.authorRef === undefined ||
      assessment.assessorRef !== options.authorRef
    ) {
      independentApprovers += 1;
    }
    if (assessment.assessorKind === 'human') humanApprovals += 1;
    if (assessment.assessorKind === 'agent') agentApprovals += 1;
    for (const capability of assessment.assuranceCapabilities ?? []) {
      approvalCapabilities.add(capability);
      if (assessment.assessorKind === 'human') {
        humanApprovalCapabilities.add(capability);
      }
    }
  }

  return {
    explicitApprovals,
    independentApprovers,
    humanApprovals,
    agentApprovals,
    approvalCapabilities: [...approvalCapabilities].sort(),
    humanApprovalCapabilities: [...humanApprovalCapabilities].sort(),
    disputingAssessors,
    disputesOpen: (options.disputes ?? []).filter((d) => d.open).length,
    abstentions,
    implicitApprovals,
    evidenceRequirementState: [...(options.evidenceRequirementState ?? [])],
  };
}

/** Build an `Assessment` from an actor snapshot, carrying its assurance capabilities. */
export function assessmentFromActor(
  actor: ActorSnapshot,
  verdict: AssessmentVerdict,
  options: { implicit?: boolean } = {},
): Assessment {
  return {
    assessorRef: actor.actorRef,
    assessorKind: actor.kind,
    verdict,
    implicit: options.implicit ?? false,
    assuranceCapabilities: [...actor.assuranceCapabilities],
  };
}

/**
 * How large a pool of eligible reviewers exists, and what quorum that pool can
 * actually satisfy.
 *
 * The design target is a fixed number of independent approvals. But a fixed
 * target is unreachable whenever the pool is smaller than the target, and an
 * unreachable target does not fail loudly — proposals simply accumulate
 * unreviewed forever. So the effective quorum is clamped to what the pool can
 * supply, floored at 1, and `degraded` says so out loud.
 */
export interface ReviewerPoolState {
  /**
   * Total reviewers in the pool, author included, or `null` when the caller
   * genuinely does not know it. Informational: no requirement reads it. A
   * caller that has only been handed a quorum must say so rather than invent a
   * pool size that would then be persisted into a decision record as fact.
   */
  readonly size: number | null;
  /** Reviewers eligible to assess *this* proposal, or `null` when unknown. */
  readonly eligibleVerifiers: number | null;
  /** The quorum the policy would like: the integrity target. */
  readonly designTargetQuorum: number;
  /** The quorum this pool can actually reach. */
  readonly effectiveQuorum: number;
  /** True when `effectiveQuorum < designTargetQuorum`. */
  readonly degraded: boolean;
}

/**
 * Clamp a design-target quorum to what a pool can supply.
 *
 * `eligibleVerifiers` below 1 still yields 1: a quorum of zero would mean
 * "publishes with no review at all", which is never the safe direction to fail
 * in. A pool that small should be blocked by some other requirement, not by
 * silently zeroing the approval bar.
 */
export function effectiveIndependentQuorum(
  eligibleVerifiers: number,
  designTargetQuorum: number,
): number {
  return Math.min(designTargetQuorum, Math.max(1, eligibleVerifiers));
}

/**
 * Derive the pool state for one proposal.
 *
 * `authorIsEligibleVerifier` is the host's answer to "may the author's own
 * assessment count here?". Note which way it cuts: it ADDS the author to the
 * eligible pool, which can *raise* the effective quorum. It is not a way to
 * lower the bar — an author cleared to review its own work still needs the
 * quorum the enlarged pool can support.
 */
export function reviewerPoolState(args: {
  poolSize: number;
  designTargetQuorum: number;
  authorIsEligibleVerifier?: boolean;
}): ReviewerPoolState {
  const eligibleVerifiers = args.authorIsEligibleVerifier
    ? args.poolSize
    : args.poolSize - 1;
  const effectiveQuorum = effectiveIndependentQuorum(
    eligibleVerifiers,
    args.designTargetQuorum,
  );
  return {
    size: args.poolSize,
    eligibleVerifiers,
    designTargetQuorum: args.designTargetQuorum,
    effectiveQuorum,
    degraded: effectiveQuorum < args.designTargetQuorum,
  };
}

/**
 * Pool state for a caller that knows the effective quorum but not the pool it
 * came from — the shape a legacy hold-reason helper needs when it is handed a
 * quorum its caller already computed.
 *
 * `size` and `eligibleVerifiers` stay `null` rather than being back-derived:
 * several pools produce the same clamped quorum, so any number here would be a
 * guess, and this state is fingerprinted into decision records.
 */
export function poolStateFromEffectiveQuorum(args: {
  effectiveQuorum: number;
  designTargetQuorum: number;
}): ReviewerPoolState {
  return {
    size: null,
    eligibleVerifiers: null,
    designTargetQuorum: args.designTargetQuorum,
    effectiveQuorum: args.effectiveQuorum,
    degraded: args.effectiveQuorum < args.designTargetQuorum,
  };
}
