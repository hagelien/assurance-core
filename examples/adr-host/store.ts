/**
 * An `AssuranceStore` over the ADR log's own tables.
 *
 * This is the adapter a host writes, and it is written here on purpose rather
 * than reusing `MemoryAssuranceStore`: running the conformance suite against
 * the core's own reference store would test the reference against itself and
 * establish nothing about whether the port fits a store it did not design.
 *
 * The translations it has to do are the ones every host has to do:
 *
 *   - **Integers become strings.** The log keys ADRs, change requests and
 *     drafts by integer. The port's identifiers are strings, on the grounds
 *     that not every store addresses a governed object by an integer. So the
 *     conversion happens here, once, at the boundary — which is the claim the
 *     core makes about that choice, now exercised rather than asserted.
 *   - **`Date` becomes ISO-8601.** The log holds real dates; the core reads no
 *     clock and takes times as strings it never interprets.
 *   - **A change request becomes a proposal, and a draft a version.** The host
 *     did not name them that and does not have to.
 *
 * Governance history — assessments, disputes, decisions — has no home in the
 * ADR log, so this adapter keeps its own tables for it. A host with a database
 * would put them in it. What it must not do is put them *in the ADR*, which is
 * the mistake the append-only rule exists to prevent: a judgment recorded on
 * the object it judges disappears the moment that object is edited.
 */

import type {
  ActorKind,
  ActorSnapshot,
  AssuranceStore,
  EvidenceRequirementState,
  OpenDisputeInput,
  OpenProposalQuery,
  ProposalVersionRef,
  RecordAssessmentInput,
  RecordDecisionInput,
  RuleDisputeInput,
  SpaceId,
  StoredAssessment,
  StoredDecision,
  StoredDispute,
  StoredDisputeRuling,
  StoredProposal,
  StoredProposalVersion,
} from '../../src/index.js';
import { formatVersionRef, sameVersion } from '../../src/index.js';
import type { AdrLog, ChangeRequest, Draft } from './log.js';

export const ADR_SPACE: SpaceId = 'adr';
export const ADR_TARGET_TYPE = 'decision_record';

/** `user:…` and `agent:…` are this host's convention, not the core's. */
export function actorKindOf(actorRef: string): ActorKind {
  return actorRef.startsWith('agent:') ? 'agent' : 'human';
}

function snapshot(actorRef: string, assuranceCapabilities: readonly string[] = []): ActorSnapshot {
  return {
    actorRef,
    kind: actorKindOf(actorRef),
    capabilities: [],
    assuranceCapabilities,
  };
}

export class AdrAssuranceStore implements AssuranceStore {
  private readonly assessments: StoredAssessment[] = [];
  private readonly disputeRecords: StoredDispute[] = [];
  private readonly rulings: StoredDisputeRuling[] = [];
  private readonly decisions: StoredDecision[] = [];
  private readonly evidence = new Map<string, readonly EvidenceRequirementState[]>();
  private counter = 0;

  constructor(
    private readonly log: AdrLog,
    /**
     * Capabilities the host knows about its actors. Server-owned: an actor
     * cannot assert its own, which is why they are looked up here rather than
     * taken from whatever recorded the assessment.
     */
    private readonly capabilities: ReadonlyMap<string, readonly string[]> = new Map(),
  ) {}

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  capabilitiesOf(actorRef: string): readonly string[] {
    return this.capabilities.get(actorRef) ?? [];
  }

  // ── Translation ──────────────────────────────────────────────────────────

  private toProposal(change: ChangeRequest): StoredProposal {
    const latest = change.drafts[change.drafts.length - 1];
    return {
      proposalId: String(change.id),
      target: {
        space: ADR_SPACE,
        type: ADR_TARGET_TYPE,
        id: String(change.adrNumber),
      },
      author: snapshot(change.openedBy, this.capabilitiesOf(change.openedBy)),
      currentVersionId: latest ? String(latest.id) : null,
      open: change.state === 'open',
      createdAt: change.openedAt.toISOString(),
    };
  }

  private toVersion(change: ChangeRequest, draft: Draft): StoredProposalVersion {
    const index = change.drafts.findIndex((d) => d.id === draft.id);
    return {
      ref: { proposalId: String(change.id), versionId: String(draft.id) },
      target: {
        space: ADR_SPACE,
        type: ADR_TARGET_TYPE,
        id: String(change.adrNumber),
      },
      author: snapshot(draft.writtenBy, this.capabilitiesOf(draft.writtenBy)),
      // Superseding an accepted record is what makes an ADR change
      // consequential — the host's judgment, which the core cannot make.
      risk:
        draft.supersedes.length > 0
          ? { level: 'high', tags: ['supersedes_accepted'] }
          : { level: 'low', tags: [] },
      payloadFingerprint: `${draft.title}|${draft.decision}|${draft.supersedes.join(',')}`,
      versionNo: index + 1,
      submittedAt: draft.submittedAt ? draft.submittedAt.toISOString() : null,
    };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async getProposal(proposalId: string): Promise<StoredProposal | null> {
    const change = this.log.change(Number(proposalId));
    return change ? this.toProposal(change) : null;
  }

  async getVersion(ref: ProposalVersionRef): Promise<StoredProposalVersion | null> {
    const found = this.log.draft(Number(ref.versionId));
    if (!found || String(found.change.id) !== ref.proposalId) return null;
    return this.toVersion(found.change, found.draft);
  }

  async latestVersion(proposalId: string): Promise<StoredProposalVersion | null> {
    const change = this.log.change(Number(proposalId));
    const draft = change?.drafts[change.drafts.length - 1];
    return change && draft ? this.toVersion(change, draft) : null;
  }

  async listOpenProposals(
    space: SpaceId,
    query: OpenProposalQuery = {},
  ): Promise<readonly StoredProposal[]> {
    if (space !== ADR_SPACE) return [];
    if (query.targetType && query.targetType !== ADR_TARGET_TYPE) return [];
    const rows = this.log
      .openChanges()
      .map((c) => this.toProposal(c))
      .filter(
        (p) =>
          !query.excludeAuthorRef || p.author.actorRef !== query.excludeAuthorRef,
      );
    return query.limit === undefined ? rows : rows.slice(0, query.limit);
  }

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

  /**
   * One standing assessment per assessor per version.
   *
   * Both forms of supersession are honoured: an explicit
   * `supersedesAssessmentId`, and simply recording again on the same version.
   * The port's conformance suite checks the first; the second is this host
   * being defensive about its own callers.
   */
  private standing(pool: readonly StoredAssessment[]): StoredAssessment[] {
    const replaced = new Set(
      pool.map((a) => a.supersedesAssessmentId).filter((v): v is string => v !== null),
    );
    const latest = new Map<string, StoredAssessment>();
    for (const assessment of pool) {
      if (replaced.has(assessment.assessmentId)) continue;
      latest.set(
        `${formatVersionRef(assessment.version)}|${assessment.assessorRef}`,
        assessment,
      );
    }
    return [...latest.values()];
  }

  async disputes(ref: ProposalVersionRef): Promise<readonly StoredDispute[]> {
    return this.disputeRecords
      .filter((d) => sameVersion(d.version, ref))
      // `open` is derived from the rulings rather than stored beside them, so
      // the projection cannot drift from the history it summarises.
      .map((d) => ({
        ...d,
        open: !this.rulings.some((r) => r.disputeId === d.disputeId),
      }));
  }

  async disputeRulings(disputeId: string): Promise<readonly StoredDisputeRuling[]> {
    return this.rulings.filter((r) => r.disputeId === disputeId);
  }

  async evidenceState(
    ref: ProposalVersionRef,
  ): Promise<readonly EvidenceRequirementState[]> {
    const declared = this.evidence.get(formatVersionRef(ref));
    if (declared) return declared;
    const version = await this.getVersion(ref);
    if (!version) return [];
    // This host's one evidence rule: a record that supersedes another must say
    // what it replaces. Computed rather than stored, because it is a property
    // of the draft.
    const found = this.log.draft(Number(ref.versionId));
    const supersedes = found?.draft.supersedes ?? [];
    if (supersedes.length === 0) return [];
    return [
      {
        requirementId: 'adr.names_what_it_replaces',
        satisfied: supersedes.every((n) => this.log.adr(n) !== undefined),
        detail: `replaces ${supersedes.join(', ')}`,
      },
    ];
  }

  async latestDecision(ref: ProposalVersionRef): Promise<StoredDecision | null> {
    const rows = this.decisions.filter((d) => sameVersion(d.version, ref));
    return rows[rows.length - 1] ?? null;
  }

  // ── Appends ──────────────────────────────────────────────────────────────

  async recordAssessment(input: RecordAssessmentInput): Promise<StoredAssessment> {
    const record: StoredAssessment = {
      assessmentId: this.id('assessment'),
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
      disputeId: this.id('dispute'),
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
    if (!this.disputeRecords.some((d) => d.disputeId === input.disputeId)) {
      throw new Error(`no dispute ${input.disputeId}`);
    }
    const record: StoredDisputeRuling = {
      rulingId: this.id('ruling'),
      disputeId: input.disputeId,
      ruling: input.ruling,
      ruledByRef: input.ruledByRef,
      rationale: input.rationale ?? null,
      ruledAt: input.ruledAt,
    };
    this.rulings.push(record);
    return record;
  }

  async recordDecision(input: RecordDecisionInput): Promise<StoredDecision> {
    const record: StoredDecision = {
      decisionId: this.id('decision'),
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

  /** Override the computed evidence state, for a test that needs a specific one. */
  declareEvidence(
    ref: ProposalVersionRef,
    state: readonly EvidenceRequirementState[],
  ): void {
    this.evidence.set(formatVersionRef(ref), state);
  }
}
