/**
 * The sealed snapshot an independent reviewer receives.
 *
 * Blind peer review is one of the mechanisms this package exists to
 * generalise, and the invariant that makes it worth anything is negative: a
 * reviewer must never see another reviewer's verdict, or the running approval
 * tally, before forming their own. A host can hold that line by construction —
 * simply never selecting the verdict columns — and construction does not
 * survive the next adapter, written by someone who never read the query that
 * was careful.
 *
 * So the invariant is enforced here at runtime, once, on the way out.
 * `sealReviewPacket` refuses to build a packet whose payload carries a peer
 * signal, and an adapter that leaks one fails loudly at the point of the leak
 * rather than quietly contaminating a review cycle.
 *
 * ## Why this belongs in the core rather than in each host
 *
 * Because the guard is worth exactly as much as the least careful adapter
 * anyone writes, and a host cannot enforce a rule on adapters it has not seen
 * yet. Putting it below the adapter boundary makes it unavoidable.
 */

import type { ProposalVersionRef, TargetRef } from './types.js';

/** A cited piece of evidence, as a reviewer needs to see it. */
export interface ReviewEvidenceRef {
  readonly kind: string;
  readonly id: string;
  /** Host-supplied display fields. Scanned for peer signals like any payload. */
  readonly summary?: Record<string, unknown>;
}

/** One thing the policy will require evidence of, so a reviewer can see what is missing. */
export interface EvidenceRequirement {
  readonly id: string;
  readonly kind: string;
  readonly description: string;
  /** False for an advisory requirement that does not block publication. */
  readonly blocking: boolean;
}

/** The version being reviewed, as the host's adapter describes it. */
export interface ReviewableVersion {
  readonly ref: ProposalVersionRef;
  readonly target: TargetRef;
  /**
   * The token a verdict is valid against. A verdict cast on this token must
   * not apply after the target has moved underneath it, which is the whole
   * reason it travels with the packet.
   */
  readonly targetVersion: string;
  /** ISO-8601. */
  readonly createdAt: string;
  readonly authorRef: string | null;
}

export interface ReviewPacket {
  readonly target: TargetRef;
  readonly proposalVersionId: string;
  readonly targetVersion: string;
  readonly createdAt: string;
  readonly authorRef: string | null;
  /** The proposed change. Adapter-shaped and opaque above this layer. */
  readonly proposed: Record<string, unknown>;
  /** The baseline the reviewer compares against. Empty when the target is new. */
  readonly current: Record<string, unknown>;
  readonly evidence: readonly ReviewEvidenceRef[];
  readonly evidenceRequirements: readonly EvidenceRequirement[];
  /** Risk framing, freshness signals, and similar. Never assurance state. */
  readonly context: Record<string, unknown>;
}

/**
 * Word stems that would hand a reviewer another reviewer's judgment, or the
 * tally.
 *
 * Matched as **substrings** of the normalised key, at every depth of the
 * packet's host-shaped sections — not by exact equality. Exact matching was
 * the first version of this and it was trivially evadable: `approvalCounts`
 * normalises to `approvalcounts`, which is neither `approvals` nor
 * `approvalcount`, so an obvious tally sealed cleanly. Any list of exact names
 * loses that race, because the thing being guarded against is a *name nobody
 * thought of*.
 *
 * Stems are deliberately blunt. A false positive costs an adapter one rename;
 * a false negative costs a review cycle its independence.
 */
const PEER_SIGNAL_STEMS: readonly string[] = [
  'verdict',
  'approval',
  'approve',
  'dispute',
  'abstain',
  'consensus',
  'quorum',
  'assurance',
  'holdreason',
  'rationale',
  'peerreview',
  'verificationsummary',
  'verificationlevel',
];

/**
 * Exact keys that trip a stem but are the object's own content rather than a
 * peer's judgment.
 *
 * The clearest case is a domain where the thing under review is itself a
 * review: its payload legitimately carries a written assessment and a
 * confidence, those are the author's own submission, and withholding them
 * would leave nothing to review.
 *
 * Matched exactly, not by stem: an escape hatch that also matched substrings
 * would let `approvalCountsSummary` through by way of `approvals`. Adding to
 * this list should always be a deliberate act about one named field.
 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'reviewmarkdown',
  'reviewconfidence',
  'readinfull',
  'readinfullunverified',
  'overallscore',
  'conclusionsupport',
  'evidencerequirements',
]);

export class ReviewPacketLeakError extends Error {
  constructor(readonly path: string) {
    super(
      `review packet would leak a peer signal at '${path}'. A reviewer packet ` +
        'must not carry other reviewers’ verdicts or the approval tally.',
    );
    this.name = 'ReviewPacketLeakError';
  }
}

function assertNoPeerSignals(
  value: unknown,
  path: string,
  seen: Set<object>,
): void {
  if (value === null || typeof value !== 'object') return;
  // Adapters hydrate from stored rows and re-use nested objects across items;
  // a shared subtree is not a cycle but would otherwise be re-walked per
  // reference, and a genuine cycle would not terminate at all.
  if (seen.has(value as object)) return;
  seen.add(value as object);

  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoPeerSignals(item, `${path}[${i}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalised = key.toLowerCase().replace(/[^a-z]/g, '');
    if (
      !ALLOWED_KEYS.has(normalised) &&
      PEER_SIGNAL_STEMS.some((stem) => normalised.includes(stem))
    ) {
      throw new ReviewPacketLeakError(`${path}.${key}`);
    }
    assertNoPeerSignals(child, `${path}.${key}`, seen);
  }
}

/**
 * Build a review packet, refusing to seal one that leaks a peer signal.
 *
 * Only the host-shaped sections are scanned. `target`, `targetVersion` and the
 * evidence-requirement list are this module's own vocabulary — scanning them
 * would trip on the layer's own field names rather than on an adapter's leak.
 */
export function sealReviewPacket(args: {
  version: ReviewableVersion;
  proposed: Record<string, unknown>;
  current?: Record<string, unknown>;
  evidence?: readonly ReviewEvidenceRef[];
  evidenceRequirements?: readonly EvidenceRequirement[];
  context?: Record<string, unknown>;
}): ReviewPacket {
  const proposed = args.proposed;
  const current = args.current ?? {};
  const evidence = args.evidence ?? [];
  const context = args.context ?? {};

  const seen = new Set<object>();
  assertNoPeerSignals(proposed, 'proposed', seen);
  assertNoPeerSignals(current, 'current', seen);
  assertNoPeerSignals(evidence, 'evidence', seen);
  assertNoPeerSignals(context, 'context', seen);

  return Object.freeze({
    target: args.version.target,
    proposalVersionId: args.version.ref.versionId,
    targetVersion: args.version.targetVersion,
    createdAt: args.version.createdAt,
    authorRef: args.version.authorRef,
    proposed,
    current,
    evidence,
    evidenceRequirements: args.evidenceRequirements ?? [],
    context,
  });
}

/** The stems the guard matches on, exposed so a host can test its own adapters against them. */
export const PEER_SIGNAL_STEM_LIST: readonly string[] = PEER_SIGNAL_STEMS;
