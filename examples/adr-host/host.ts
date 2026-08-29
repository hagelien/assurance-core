/**
 * The governance wiring: policy, review packets, and the flow that runs a
 * change request from submitted to merged.
 *
 * Everything domain-specific is here, and it is worth naming what that turned
 * out to be — it is the list of things a core cannot do for a host:
 *
 *   1. **Risk.** Whether a change is consequential (in `store.ts`, because it
 *      is a property of a draft): superseding an accepted record is a big
 *      deal, editing prose is not. No amount of generic machinery could infer
 *      that.
 *   2. **Policy.** How much review each risk level needs. Written with the
 *      core's requirement primitives, but the choice of them is this host's.
 *   3. **Visibility and packet content.** Which rows a reviewer may see, and
 *      what a reviewer needs in front of them.
 *   4. **Publishing.** What "merged" means to an ADR log.
 *
 * Everything else — tallying, the eligibility rules, the blind-review guard,
 * evaluating the policy, recording the decision — came from the package
 * unchanged.
 */

import {
  assessmentFromActor,
  candidatesFromStore,
  fingerprintPolicyContext,
  humanApproval,
  independentApprovals,
  noDisputingAssessments,
  noOpenDisputes,
  policy,
  reviewerPoolState,
  sealReviewPacket,
  selectReviewQueue,
  snapshotActor,
  tallyAssurance,
  toAssessment,
  type ActorContext,
  type AssessmentVerdict,
  type PolicyContext,
  type PolicyDecision,
  type PolicySet,
  type ProposalVersionRef,
  type ReviewPacket,
  type ReviewQueueResult,
} from '../../src/index.js';
import type { AdrLog } from './log.js';
import { ADR_SPACE, ADR_TARGET_TYPE, type AdrAssuranceStore } from './store.js';

/**
 * This host's rules.
 *
 * Two reviewers and no unresolved objection for anything; a named human
 * sign-off on top when a record supersedes an accepted one. The second rule is
 * the whole reason this host wanted governance: agents agreeing with each
 * other is not enough to retire a decision the team already made.
 */
export const ADR_POLICY: PolicySet = policy('adr-review', 'v1')
  .rule({
    id: 'baseline',
    require: [
      independentApprovals(2),
      noDisputingAssessments(),
      noOpenDisputes(),
    ],
  })
  .rule({
    id: 'supersede-needs-a-human',
    when: { risk: 'high', riskTags: ['supersedes_accepted'] },
    require: [humanApproval()],
  })
  .build();

export interface AdrHostOptions {
  readonly log: AdrLog;
  readonly store: AdrAssuranceStore;
  /** How many actors could review at all — the pool the quorum is read against. */
  readonly reviewerPoolSize: number;
  /** Injected so a test or a replay controls time; a real host would use a clock. */
  now(): Date;
}

export class AdrHost {
  constructor(private readonly options: AdrHostOptions) {}

  private stamp(): string {
    return this.options.now().toISOString();
  }

  /**
   * What a reviewer is given.
   *
   * `sealReviewPacket` refuses to build one carrying a peer signal, so a
   * mistake here — adding a "current approvals" convenience for the UI — fails
   * at the point of the mistake rather than contaminating a review.
   */
  async packetFor(ref: ProposalVersionRef): Promise<ReviewPacket> {
    const version = await this.options.store.getVersion(ref);
    if (!version) throw new Error(`no version ${ref.versionId}`);
    const found = this.options.log.draft(Number(ref.versionId));
    if (!found) throw new Error(`no draft ${ref.versionId}`);
    const adr = this.options.log.adr(found.change.adrNumber);

    return sealReviewPacket({
      version: {
        ref,
        target: version.target,
        targetVersion: String(adr?.revision ?? 0),
        createdAt: version.submittedAt ?? this.stamp(),
        authorRef: version.author.actorRef,
      },
      proposed: {
        title: found.draft.title,
        context: found.draft.context,
        decision: found.draft.decision,
        supersedes: found.draft.supersedes,
      },
      current: adr
        ? { title: adr.title, decision: adr.decision, status: adr.status }
        : {},
      evidenceRequirements: (await this.options.store.evidenceState(ref)).map(
        (state) => ({
          id: state.requirementId,
          kind: 'reference',
          description: 'a superseding record must name what it replaces',
          blocking: true,
        }),
      ),
      context: { risk: version.risk.level, riskTags: version.risk.tags },
    });
  }

  /** The queue, with this host's one visibility rule applied. */
  async queueFor(reviewer: ActorContext, limit = 10): Promise<ReviewQueueResult> {
    const drawn = await candidatesFromStore(this.options.store, ADR_SPACE);
    const candidates = drawn.map((candidate) => ({
      ...candidate,
      // The host's own rule, which the core cannot supply: a change against a
      // record that no longer exists is not shown to anybody.
      visible: this.options.log.adr(Number(candidate.target.id)) !== undefined,
    }));
    return selectReviewQueue({
      store: this.options.store,
      reviewerRef: reviewer.actorRef,
      candidates,
      limit,
    });
  }

  /**
   * Record one reviewer's verdict, with the capabilities they held at the time.
   *
   * The capabilities come from the host's own record of the actor, never from
   * the `ActorContext` the caller passed in. That distinction is the whole
   * point of calling them server-owned: an agent that could state its own tier
   * could clear a capability gate by claiming to be something it is not, and
   * the claim would be frozen into the assessment snapshot and keep clearing
   * that gate afterwards.
   */
  async assess(
    reviewer: ActorContext,
    ref: ProposalVersionRef,
    verdict: AssessmentVerdict,
  ): Promise<void> {
    const held = this.options.store.capabilitiesOf(reviewer.actorRef);
    await this.options.store.recordAssessment({
      version: ref,
      assessorRef: reviewer.actorRef,
      assessorKind: reviewer.kind,
      verdict,
      ...(held.length > 0 ? { assuranceCapabilities: held } : {}),
      recordedAt: this.stamp(),
    });
  }

  /** Assemble the context the policy is evaluated against. */
  async contextFor(ref: ProposalVersionRef): Promise<PolicyContext> {
    const version = await this.options.store.getVersion(ref);
    if (!version) throw new Error(`no version ${ref.versionId}`);
    const assessments = (
      await this.options.store.currentAssessments(ref)
    ).map(toAssessment);
    const disputes = (await this.options.store.disputes(ref)).map((d) => ({
      disputeId: d.disputeId,
      openedByRef: d.openedByRef,
      openedByKind: d.openedByKind,
      open: d.open,
    }));

    return {
      space: ADR_SPACE,
      targetType: ADR_TARGET_TYPE,
      proposalVersionId: ref.versionId,
      author: version.author,
      risk: version.risk,
      assurance: tallyAssurance(assessments, {
        authorRef: version.author.actorRef,
        disputes,
        evidenceRequirementState: await this.options.store.evidenceState(ref),
      }),
      // The design target is this host's ambition; `reviewerPoolState` clamps
      // it to what the pool can actually supply and reports `degraded` when it
      // had to. A two-person team does not get a silently lowered bar — it
      // gets a bar it can reach, and a record saying so.
      pool: reviewerPoolState({
        poolSize: this.options.reviewerPoolSize,
        designTargetQuorum: 2,
      }),
      flags: [],
    };
  }

  /**
   * Evaluate, record the decision, and publish if it is allowed.
   *
   * The decision is recorded whether or not it permits publication. A held
   * proposal that leaves no trace of *why* it was held is the state this whole
   * arrangement exists to avoid.
   */
  async tryPublish(ref: ProposalVersionRef): Promise<{
    decision: PolicyDecision;
    merged: boolean;
  }> {
    const context = await this.contextFor(ref);
    const decision = ADR_POLICY.evaluate(context);
    await this.options.store.recordDecision({
      version: ref,
      policyId: ADR_POLICY.id,
      policyVersion: ADR_POLICY.version,
      allowed: decision.allowed,
      inputFingerprint: fingerprintPolicyContext(context),
      mode: 'authoritative',
      evaluatedAt: this.stamp(),
    });
    if (!decision.allowed) return { decision, merged: false };

    // The host act. There is no core primitive for this and there should not
    // be: bumping a revision and retiring the records this one replaces means
    // nothing outside an ADR log.
    this.options.log.merge(Number(ref.versionId));
    return { decision, merged: true };
  }
}

/** Build the implicit assessment a host records for an author at submit time. */
export function authorStake(author: ActorContext): ReturnType<typeof assessmentFromActor> {
  return assessmentFromActor(snapshotActor(author), 'approve', { implicit: true });
}
