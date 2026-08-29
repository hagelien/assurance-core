/**
 * The persistence port.
 *
 * This package decides; it does not remember. Everything above this file takes
 * its inputs as arguments and returns values, which is what makes a decision
 * reproducible a year later. But a *review* is not a single decision — it is a
 * sequence of them over days, against records only a host can hold — so
 * something has to describe the shape of that memory without owning it.
 *
 * That is what `AssuranceStore` is: an interface the core depends on and no
 * file here implements against a real database. A host supplies the
 * implementation; the core supplies the questions. The direction matters. Had
 * persistence been extracted the other way — the core growing a storage layer
 * and the host handing it a connection — this package would carry a driver,
 * and the zero-dependency property that makes it worth taking would be gone.
 *
 * ## What the port deliberately cannot do
 *
 * There is no `createProposal`, no `appendVersion`, no `publish`, and no way
 * to set a proposal's state. Those are host acts, and the absence is the
 * boundary rather than a gap waiting to be filled:
 *
 *   - A proposal exists because someone used the host's submit path. Its
 *     payload is domain content this package cannot read and must not shape.
 *   - Publishing writes to the host's own tables — a page, a record, a file —
 *     through the host's target adapter. What "applied" means is exactly the
 *     part that does not generalise.
 *
 * What the port *does* carry is the governance history: assessments, disputes,
 * their rulings, and the decisions taken against a version. Those are the same
 * in every domain, which is why they are the ones that could leave.
 *
 * ## Append-only, and where the exceptions are
 *
 * Every write here appends. A reviewer who changes their mind records a new
 * assessment that supersedes the old one; a resolved dispute gets a ruling,
 * not an edit. Nothing in this interface updates or deletes, which is the same
 * enforcement-by-absence used above — a host that wants to rewrite a judgment
 * has to reach past the port to do it, and that is visible in review.
 *
 * `open` on a dispute and `currentVersionId` on a proposal are projections
 * over that history, offered because computing them from scratch on every read
 * is wasteful. Where a projection and the history disagree, the history is
 * right.
 *
 * ## Identifiers
 *
 * Strings, for the reason given in `types.ts`: the core must not assume a
 * governed object is addressable by an integer in every store. A host with
 * integer keys stringifies on the way in and parses on the way out, once, at
 * the adapter.
 *
 * ## Timestamps
 *
 * ISO-8601 strings, assigned by the host, never read by the core for anything
 * but ordering and display. This package reads no clock — see the build
 * config — so a record's time is something it is told, not something it knows.
 */

import type { ActorKind, ActorSnapshot } from './actors.js';
import type {
  Assessment,
  AssessmentVerdict,
  DisputeState,
  EvidenceRequirementState,
} from './assurance.js';
import type { RiskProfile } from './risk.js';
import type {
  Fingerprint,
  PolicyId,
  PolicyVersion,
  ProposalVersionRef,
  SpaceId,
  TargetRef,
  TargetType,
} from './types.js';

/** An ISO-8601 instant, as the host recorded it. */
export type Timestamp = string;

/**
 * A proposal, as governance sees it: who proposed a change to what, whether it
 * is still open, and which of its versions is current. The payload is absent
 * on purpose — it is domain content, and this package has no business holding
 * an opinion about it.
 */
export interface StoredProposal {
  readonly proposalId: string;
  readonly target: TargetRef;
  readonly author: ActorSnapshot;
  /** Null before the first version is submitted. */
  readonly currentVersionId: string | null;
  readonly open: boolean;
  readonly createdAt: Timestamp;
}

/**
 * One immutable version of a proposal.
 *
 * `risk` is the host's classification, produced by its target adapter: this
 * package cannot judge how consequential a change is without knowing what the
 * change means. `payloadFingerprint` is the only thing it holds about the
 * content itself, and it only ever compares one for equality.
 */
export interface StoredProposalVersion {
  readonly ref: ProposalVersionRef;
  readonly target: TargetRef;
  readonly author: ActorSnapshot;
  readonly risk: RiskProfile;
  readonly payloadFingerprint: Fingerprint;
  /** 1 for the first version, incrementing on each revision. */
  readonly versionNo: number;
  /** Null while still a draft. A version is reviewable once submitted. */
  readonly submittedAt: Timestamp | null;
}

/**
 * A recorded assessment, with the identity and lineage the bare `Assessment`
 * omits. `Assessment` is what the tally consumes; this is what the store holds.
 */
export interface StoredAssessment extends Assessment {
  readonly assessmentId: string;
  readonly version: ProposalVersionRef;
  /** The assessment this one replaces, when the assessor revised a verdict. */
  readonly supersedesAssessmentId: string | null;
  readonly recordedAt: Timestamp;
}

/** A dispute, with the version it objects to. `open` is a projection over its rulings. */
export interface StoredDispute extends DisputeState {
  readonly version: ProposalVersionRef;
  readonly openedAt: Timestamp;
}

/** How a dispute was settled. Appended; a dispute may carry several over its life. */
export interface StoredDisputeRuling {
  readonly rulingId: string;
  readonly disputeId: string;
  readonly ruling: 'upheld' | 'rejected' | 'withdrawn';
  readonly ruledByRef: string;
  readonly rationale: string | null;
  readonly ruledAt: Timestamp;
}

/**
 * Whether a decision was binding.
 *
 * `shadow` exists because the honest way to introduce a policy engine is to
 * run it alongside whatever decides today and compare, before anything depends
 * on it. A shadow decision is recorded and inspected; it publishes nothing.
 */
export type DecisionMode = 'shadow' | 'authoritative';

/**
 * One evaluation of a policy against one version.
 *
 * `inputFingerprint` is what makes the record auditable: it names the exact
 * context the decision was taken over, so re-evaluating the same inputs under
 * the same policy version must reach the same answer, and a disagreement
 * points at either the policy or the inputs rather than leaving both suspect.
 */
export interface StoredDecision {
  readonly decisionId: string;
  readonly version: ProposalVersionRef;
  readonly policyId: PolicyId;
  readonly policyVersion: PolicyVersion;
  readonly allowed: boolean;
  readonly inputFingerprint: Fingerprint;
  readonly mode: DecisionMode;
  readonly evaluatedAt: Timestamp;
}

/** What a caller supplies to record an assessment; the store assigns the rest. */
export interface RecordAssessmentInput {
  readonly version: ProposalVersionRef;
  readonly assessorRef: string;
  readonly assessorKind: ActorKind;
  readonly verdict: AssessmentVerdict;
  readonly implicit?: boolean;
  /**
   * The assessor's assurance capabilities **at this moment**, not later. The
   * snapshot is what closes the revocation window: a verdict admitted before a
   * capability was withdrawn must not keep clearing a gate afterwards.
   */
  readonly assuranceCapabilities?: readonly string[];
  /**
   * Set when the assessor is revising: the store supersedes that assessment
   * rather than holding two positions for one reviewer.
   */
  readonly supersedesAssessmentId?: string;
  readonly recordedAt: Timestamp;
}

export interface OpenDisputeInput {
  readonly version: ProposalVersionRef;
  readonly openedByRef: string;
  readonly openedByKind: ActorKind;
  readonly rationale?: string | null;
  readonly openedAt: Timestamp;
}

export interface RuleDisputeInput {
  readonly disputeId: string;
  readonly ruling: StoredDisputeRuling['ruling'];
  readonly ruledByRef: string;
  readonly rationale?: string | null;
  readonly ruledAt: Timestamp;
}

export interface RecordDecisionInput {
  readonly version: ProposalVersionRef;
  readonly policyId: PolicyId;
  readonly policyVersion: PolicyVersion;
  readonly allowed: boolean;
  readonly inputFingerprint: Fingerprint;
  readonly mode: DecisionMode;
  readonly evaluatedAt: Timestamp;
}

/** Narrowing for `listOpenProposals`. All fields are optional and AND together. */
export interface OpenProposalQuery {
  readonly targetType?: TargetType;
  /** Exclude proposals authored by this actor — the self-review filter. */
  readonly excludeAuthorRef?: string;
  readonly limit?: number;
}

/**
 * Everything a host must be able to answer for a review to run.
 *
 * Every method is async because a real store is, and pretending otherwise
 * would force every host into a synchronous cache. An in-memory
 * implementation lives in `store-memory.ts`; the contract every
 * implementation must satisfy is executable, in `store-conformance.ts`.
 */
export interface AssuranceStore {
  // ── Reads ────────────────────────────────────────────────────────────────

  getProposal(proposalId: string): Promise<StoredProposal | null>;

  getVersion(ref: ProposalVersionRef): Promise<StoredProposalVersion | null>;

  /** The highest-numbered version of a proposal, submitted or not. */
  latestVersion(proposalId: string): Promise<StoredProposalVersion | null>;

  /**
   * Open proposals in a space, oldest first.
   *
   * Oldest-first because a review queue that serves newest-first starves its
   * own backlog: the rows nobody has looked at are exactly the rows that keep
   * getting pushed down.
   */
  listOpenProposals(
    space: SpaceId,
    query?: OpenProposalQuery,
  ): Promise<readonly StoredProposal[]>;

  /**
   * The standing assessments on a version — one per assessor, superseded ones
   * excluded. This is what feeds the tally, so a store that returned the full
   * history here would double-count every reviewer who changed their mind.
   */
  currentAssessments(
    ref: ProposalVersionRef,
  ): Promise<readonly StoredAssessment[]>;

  /**
   * Every assessment this actor holds across the given versions, superseded
   * ones excluded.
   *
   * Batched over versions rather than asked one at a time because the caller
   * is a queue deciding which of many proposals an actor has already judged,
   * and doing that one round trip per row is how a queue becomes the slowest
   * endpoint a host has.
   */
  assessmentsByActor(
    actorRef: string,
    versions: readonly ProposalVersionRef[],
  ): Promise<readonly StoredAssessment[]>;

  /** Disputes against a version, open and settled. */
  disputes(ref: ProposalVersionRef): Promise<readonly StoredDispute[]>;

  /** Rulings on one dispute, oldest first. */
  disputeRulings(disputeId: string): Promise<readonly StoredDisputeRuling[]>;

  /**
   * Which of the host's declared evidence requirements this version satisfies.
   *
   * The host answers, because only the host knows what counts as evidence in
   * its domain. The core reads the booleans and nothing else.
   */
  evidenceState(
    ref: ProposalVersionRef,
  ): Promise<readonly EvidenceRequirementState[]>;

  /** The most recent decision recorded against a version, in either mode. */
  latestDecision(ref: ProposalVersionRef): Promise<StoredDecision | null>;

  // ── Appends ──────────────────────────────────────────────────────────────

  recordAssessment(input: RecordAssessmentInput): Promise<StoredAssessment>;

  openDispute(input: OpenDisputeInput): Promise<StoredDispute>;

  ruleDispute(input: RuleDisputeInput): Promise<StoredDisputeRuling>;

  recordDecision(input: RecordDecisionInput): Promise<StoredDecision>;
}

/**
 * Canonical string form of a version reference, for map keys and logs.
 *
 * Both halves are included even though a version id is usually unique on its
 * own: "usually" is a property of one host's id generator, not of this
 * interface, and a key that collides across proposals would silently merge two
 * proposals' review state.
 */
export function formatVersionRef(ref: ProposalVersionRef): string {
  return `${ref.proposalId}#${ref.versionId}`;
}

/** Whether two version references address the same version. */
export function sameVersion(
  a: ProposalVersionRef,
  b: ProposalVersionRef,
): boolean {
  return a.proposalId === b.proposalId && a.versionId === b.versionId;
}

/**
 * Strip a stored assessment down to what the tally consumes.
 *
 * The tally must not see an assessment's id or its lineage: `tallyAssurance`
 * counts distinct assessors, and handing it fields that differ per row is how
 * a reviewer who revised a verdict starts counting twice.
 */
export function toAssessment(stored: StoredAssessment): Assessment {
  return {
    assessorRef: stored.assessorRef,
    assessorKind: stored.assessorKind,
    verdict: stored.verdict,
    implicit: stored.implicit,
    ...(stored.assuranceCapabilities
      ? { assuranceCapabilities: stored.assuranceCapabilities }
      : {}),
  };
}
