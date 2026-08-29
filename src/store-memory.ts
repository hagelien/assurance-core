/**
 * An in-memory `AssuranceStore`, for tests, examples, and evaluating whether
 * this package fits a domain before wiring it to anything durable.
 *
 * It is a reference implementation in the strict sense: the conformance suite
 * runs against it, so "what the port means" and "what this file does" are kept
 * the same thing by a test rather than by intention.
 *
 * ## Why nothing here reads a clock or a random source
 *
 * The package generates no time and no randomness — that is a build-level
 * constraint, not a preference — so this store assigns ids from a counter and
 * takes every timestamp from its caller. The result is a store whose entire
 * output is a function of the calls made to it, which is what lets a
 * conformance run, an example, or a failing test be replayed exactly.
 *
 * ## Seeding is not part of the port
 *
 * `seedProposal` and `seedVersion` exist here and deliberately not on
 * `AssuranceStore`. Creating a proposal is a host act: it happens in a submit
 * path, over domain content this package cannot read. A real host already has
 * those rows before governance is asked anything. This store has to be given
 * them somehow, and putting that somewhere other than the interface keeps the
 * interface honest about what governance may do.
 */

import type { ActorSnapshot } from './actors.js';
import type { EvidenceRequirementState } from './assurance.js';
import type { RiskProfile } from './risk.js';
import { LOW_RISK } from './risk.js';
import type {
  Fingerprint,
  ProposalVersionRef,
  SpaceId,
  TargetRef,
} from './types.js';
import { formatTargetRef } from './types.js';
import type {
  AssuranceStore,
  OpenDisputeInput,
  OpenProposalQuery,
  RecordAssessmentInput,
  RecordDecisionInput,
  RuleDisputeInput,
  StoredAssessment,
  StoredDecision,
  StoredDispute,
  StoredDisputeRuling,
  StoredProposal,
  StoredProposalVersion,
  Timestamp,
} from './store.js';
import { formatVersionRef, sameVersion } from './store.js';

export interface SeedProposalInput {
  /**
   * Optional, and optional for a reason worth stating: a host's identifiers
   * come from its own store, so nothing may require a caller to choose one.
   * Supplying it is a convenience for a test that wants readable ids; omitting
   * it is what a real host does.
   */
  readonly proposalId?: string;
  readonly target: TargetRef;
  readonly author: ActorSnapshot;
  readonly createdAt: Timestamp;
  readonly open?: boolean;
}

export interface SeedVersionInput {
  readonly proposalId: string;
  readonly versionId?: string;
  readonly risk?: RiskProfile;
  readonly payloadFingerprint?: Fingerprint;
  readonly submittedAt?: Timestamp | null;
  /** Overrides the proposal's author, for a revision written by someone else. */
  readonly author?: ActorSnapshot;
}

/**
 * The in-memory store, plus the seeding surface the port does not carry.
 *
 * Exposed as a class rather than a closure so a host can subclass it to model
 * a quirk of its own store — a read that lags a write, say — and then run the
 * conformance suite against the subclass to see which parts of the contract
 * that quirk breaks.
 */
export class MemoryAssuranceStore implements AssuranceStore {
  private readonly proposals = new Map<string, StoredProposal>();
  private readonly versions = new Map<string, StoredProposalVersion>();
  private readonly assessments: StoredAssessment[] = [];
  private readonly disputeRecords: StoredDispute[] = [];
  private readonly rulings: StoredDisputeRuling[] = [];
  private readonly decisions: StoredDecision[] = [];
  private readonly evidence = new Map<string, readonly EvidenceRequirementState[]>();
  private counter = 0;

  /** Monotonic, deterministic, and scoped to this instance. */
  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  // ── Seeding (host acts, not part of `AssuranceStore`) ────────────────────

  seedProposal(input: SeedProposalInput): StoredProposal {
    const record: StoredProposal = {
      proposalId: input.proposalId ?? this.nextId('proposal'),
      target: input.target,
      author: input.author,
      currentVersionId: null,
      open: input.open ?? true,
      createdAt: input.createdAt,
    };
    this.proposals.set(record.proposalId, record);
    return record;
  }

  seedVersion(input: SeedVersionInput): StoredProposalVersion {
    const proposal = this.proposals.get(input.proposalId);
    if (!proposal) {
      throw new Error(`seedVersion: no proposal ${input.proposalId}`);
    }
    const versionNo = this.versionsOf(input.proposalId).length + 1;
    const versionId = input.versionId ?? this.nextId('version');
    const record: StoredProposalVersion = {
      ref: { proposalId: input.proposalId, versionId },
      target: proposal.target,
      author: input.author ?? proposal.author,
      risk: input.risk ?? LOW_RISK,
      payloadFingerprint: input.payloadFingerprint ?? `seed:${versionId}`,
      versionNo,
      submittedAt: input.submittedAt === undefined ? proposal.createdAt : input.submittedAt,
    };
    this.versions.set(formatVersionRef(record.ref), record);
    // The current-version projection follows the latest seeded version, the
    // same way a host's would follow its latest submitted one.
    this.proposals.set(proposal.proposalId, {
      ...proposal,
      currentVersionId: versionId,
    });
    return record;
  }

  /** Declare which evidence requirements a version satisfies. A host computes this. */
  seedEvidence(
    ref: ProposalVersionRef,
    state: readonly EvidenceRequirementState[],
  ): void {
    this.evidence.set(formatVersionRef(ref), state);
  }

  /** Close a proposal, as a host's apply or reject path would. */
  seedClosed(proposalId: string): void {
    const proposal = this.proposals.get(proposalId);
    if (proposal) this.proposals.set(proposalId, { ...proposal, open: false });
  }

  private versionsOf(proposalId: string): StoredProposalVersion[] {
    return [...this.versions.values()]
      .filter((v) => v.ref.proposalId === proposalId)
      .sort((a, b) => a.versionNo - b.versionNo);
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async getProposal(proposalId: string): Promise<StoredProposal | null> {
    return this.proposals.get(proposalId) ?? null;
  }

  async getVersion(ref: ProposalVersionRef): Promise<StoredProposalVersion | null> {
    return this.versions.get(formatVersionRef(ref)) ?? null;
  }

  async latestVersion(proposalId: string): Promise<StoredProposalVersion | null> {
    const all = this.versionsOf(proposalId);
    return all[all.length - 1] ?? null;
  }

  async listOpenProposals(
    space: SpaceId,
    query: OpenProposalQuery = {},
  ): Promise<readonly StoredProposal[]> {
    const matches = [...this.proposals.values()]
      .filter((p) => p.open && p.target.space === space)
      .filter((p) => !query.targetType || p.target.type === query.targetType)
      .filter(
        (p) =>
          !query.excludeAuthorRef ||
          p.author.actorRef !== query.excludeAuthorRef,
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.proposalId.localeCompare(b.proposalId),
      );
    return query.limit === undefined ? matches : matches.slice(0, query.limit);
  }

  /**
   * Standing assessments only.
   *
   * An assessment is superseded when a later one names it, and also when the
   * same assessor simply records again on the same version. Hosts differ on
   * which of the two they write, and a store that honoured only the explicit
   * form would let a careless caller double-count a reviewer.
   */
  async currentAssessments(
    ref: ProposalVersionRef,
  ): Promise<readonly StoredAssessment[]> {
    return this.standing(this.assessments.filter((a) => sameVersion(a.version, ref)));
  }

  async assessmentsByActor(
    actorRef: string,
    versions: readonly ProposalVersionRef[],
  ): Promise<readonly StoredAssessment[]> {
    const wanted = new Set(versions.map(formatVersionRef));
    return this.standing(
      this.assessments.filter(
        (a) => a.assessorRef === actorRef && wanted.has(formatVersionRef(a.version)),
      ),
    );
  }

  private standing(pool: readonly StoredAssessment[]): StoredAssessment[] {
    const superseded = new Set(
      pool
        .map((a) => a.supersedesAssessmentId)
        .filter((id): id is string => id !== null),
    );
    const byAssessor = new Map<string, StoredAssessment>();
    for (const assessment of pool) {
      if (superseded.has(assessment.assessmentId)) continue;
      const key = `${formatVersionRef(assessment.version)}|${assessment.assessorRef}`;
      byAssessor.set(key, assessment);
    }
    return [...byAssessor.values()].sort((a, b) =>
      a.assessmentId.localeCompare(b.assessmentId),
    );
  }

  async disputes(ref: ProposalVersionRef): Promise<readonly StoredDispute[]> {
    return this.disputeRecords.filter((d) => sameVersion(d.version, ref));
  }

  async disputeRulings(disputeId: string): Promise<readonly StoredDisputeRuling[]> {
    return this.rulings.filter((r) => r.disputeId === disputeId);
  }

  async evidenceState(
    ref: ProposalVersionRef,
  ): Promise<readonly EvidenceRequirementState[]> {
    return this.evidence.get(formatVersionRef(ref)) ?? [];
  }

  async latestDecision(ref: ProposalVersionRef): Promise<StoredDecision | null> {
    const matches = this.decisions.filter((d) => sameVersion(d.version, ref));
    return matches[matches.length - 1] ?? null;
  }

  // ── Appends ──────────────────────────────────────────────────────────────

  async recordAssessment(input: RecordAssessmentInput): Promise<StoredAssessment> {
    if (!this.versions.has(formatVersionRef(input.version))) {
      throw new Error(
        `recordAssessment: no version ${formatVersionRef(input.version)}`,
      );
    }
    const record: StoredAssessment = {
      assessmentId: this.nextId('assessment'),
      version: input.version,
      assessorRef: input.assessorRef,
      assessorKind: input.assessorKind,
      verdict: input.verdict,
      implicit: input.implicit ?? false,
      supersedesAssessmentId: input.supersedesAssessmentId ?? null,
      recordedAt: input.recordedAt,
      ...(input.assuranceCapabilities
        ? { assuranceCapabilities: [...input.assuranceCapabilities] }
        : {}),
    };
    this.assessments.push(record);
    return record;
  }

  async openDispute(input: OpenDisputeInput): Promise<StoredDispute> {
    const record: StoredDispute = {
      disputeId: this.nextId('dispute'),
      version: input.version,
      openedByRef: input.openedByRef,
      openedByKind: input.openedByKind,
      open: true,
      openedAt: input.openedAt,
    };
    this.disputeRecords.push(record);
    return record;
  }

  async ruleDispute(input: RuleDisputeInput): Promise<StoredDisputeRuling> {
    const index = this.disputeRecords.findIndex(
      (d) => d.disputeId === input.disputeId,
    );
    if (index === -1) throw new Error(`ruleDispute: no dispute ${input.disputeId}`);
    const record: StoredDisputeRuling = {
      rulingId: this.nextId('ruling'),
      disputeId: input.disputeId,
      ruling: input.ruling,
      ruledByRef: input.ruledByRef,
      rationale: input.rationale ?? null,
      ruledAt: input.ruledAt,
    };
    this.rulings.push(record);
    // The `open` flag is a projection over rulings: any ruling settles it.
    // Recomputed rather than toggled, so replaying the rulings reproduces it.
    const existing = this.disputeRecords[index]!;
    this.disputeRecords[index] = { ...existing, open: false };
    return record;
  }

  async recordDecision(input: RecordDecisionInput): Promise<StoredDecision> {
    const record: StoredDecision = {
      decisionId: this.nextId('decision'),
      version: input.version,
      policyId: input.policyId,
      policyVersion: input.policyVersion,
      allowed: input.allowed,
      inputFingerprint: input.inputFingerprint,
      mode: input.mode,
      evaluatedAt: input.evaluatedAt,
    };
    this.decisions.push(record);
    return record;
  }

  /** Everything held, for a test that needs to assert on the whole history. */
  dump(): {
    proposals: readonly StoredProposal[];
    versions: readonly StoredProposalVersion[];
    assessments: readonly StoredAssessment[];
    disputes: readonly StoredDispute[];
    rulings: readonly StoredDisputeRuling[];
    decisions: readonly StoredDecision[];
  } {
    return {
      proposals: [...this.proposals.values()],
      versions: [...this.versions.values()],
      assessments: [...this.assessments],
      disputes: [...this.disputeRecords],
      rulings: [...this.rulings],
      decisions: [...this.decisions],
    };
  }
}

/** Convenience for the common case; `new MemoryAssuranceStore()` is the same thing. */
export function memoryStore(): MemoryAssuranceStore {
  return new MemoryAssuranceStore();
}

/** A target reference formatted for a message, re-exported so callers need one import. */
export { formatTargetRef };
