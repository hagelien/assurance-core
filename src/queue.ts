/**
 * Who gets asked to review what.
 *
 * A review queue looks like a listing problem and is really an eligibility
 * problem: three rules decide whether a reviewer may be shown a proposal, and
 * every one of them is the same in every domain.
 *
 *   1. A row the reviewer may not see at all is not a candidate.
 *   2. A reviewer does not review their own work.
 *   3. A reviewer who has already formed a judgment is not asked again.
 *
 * The reason to state them once, here, is what happens when they are not. A
 * host that answers "who may review this?" inside each target type's own query
 * writes those three rules out once per type, and they agree only for as long
 * as someone keeps them in step by hand. They drift silently, because a queue
 * that shows one row too few looks exactly like a quiet backlog, and a queue
 * that shows one row too many looks exactly like a reviewer being diligent.
 *
 * What a host still owns is which rows exist, and its own visibility rule —
 * genuine domain knowledge that cannot be moved. It supplies candidates; every
 * rule that is the same for all of them is applied here.
 *
 * ## The self-review subtlety
 *
 * Rule 3 asks whether the reviewer has formed a *judgment*, not whether a row
 * exists with their name on it. Where a host records an author's submit-time
 * stake as an implicit assessment, those two questions differ, and reading the
 * second one hides exactly the work a self-review grant exists to surface: a
 * self-reviewing author has an implicit row on everything they submitted. So
 * implicit assessments never count as a judgment here. For a reviewer without
 * the grant the readings coincide anyway, because rule 2 has already excluded
 * their own work.
 */

import type { AssuranceStore, Timestamp } from './store.js';
import { formatVersionRef } from './store.js';
import type { ProposalVersionRef, SpaceId, TargetRef, TargetType } from './types.js';

/**
 * One proposal version a host could put in front of a reviewer, stripped to
 * what the generic rules need.
 *
 * Deliberately thin. `visible` is the one field a host must decide for itself:
 * whether a row may be shown at all is a domain question, and a core that
 * guessed at it would be guessing about access control.
 */
export interface ReviewCandidate {
  readonly version: ProposalVersionRef;
  readonly target: TargetRef;
  /** ISO-8601. The age and cross-type ordering key. */
  readonly createdAt: Timestamp;
  /** The author, or null where the host records none. Null is never the caller. */
  readonly authorRef: string | null;
  /** False for a row this host must never show a reviewer. */
  readonly visible: boolean;
}

export type ExclusionReason =
  | 'not_visible'
  | 'authored_by_caller'
  | 'already_judged';

export interface EligibilityResult {
  readonly eligible: readonly ReviewCandidate[];
  /** Every candidate considered and dropped, with why. */
  readonly excluded: ReadonlyArray<{
    readonly candidate: ReviewCandidate;
    readonly reason: ExclusionReason;
  }>;
}

/**
 * A share of the batch held for one target type.
 *
 * Without reserves a pure oldest-first merge buries a low-volume type behind
 * whatever the host produces most of, however important the buried type is. A
 * host that does not want them passes none, and gets oldest-first.
 */
export interface TypeReserve {
  readonly targetType: TargetType;
  /** Between 0 and 1. Rounded up, and never more than the batch has room for. */
  readonly fraction: number;
}

export interface ReviewQueueResult {
  readonly items: readonly ReviewCandidate[];
  readonly excluded: EligibilityResult['excluded'];
  /** How many candidates were considered, before any rule was applied. */
  readonly examined: number;
}

/**
 * Apply every rule that is the same for every target type.
 *
 * Order is deliberate and is the order reasons are reported in: a row a
 * reviewer may not see at all is not "their own work", and a row they wrote is
 * not "already judged". Reporting the first applicable reason rather than all
 * of them keeps a diagnostic saying *why* a candidate was dropped rather than
 * listing everything that would also have dropped it.
 */
export function filterEligible(args: {
  candidates: readonly ReviewCandidate[];
  reviewerRef: string;
  /**
   * A host grant, never a request assertion. It withholds rule 2 and nothing
   * else — and a host must re-check it on the write path, so that a stale
   * queue listing can never be turned into a verdict on its own.
   */
  selfReviewEnabled?: boolean;
  judged: ReadonlySet<string>;
}): EligibilityResult {
  const eligible: ReviewCandidate[] = [];
  const excluded: Array<{ candidate: ReviewCandidate; reason: ExclusionReason }> =
    [];

  for (const candidate of args.candidates) {
    if (!candidate.visible) {
      excluded.push({ candidate, reason: 'not_visible' });
      continue;
    }
    if (
      !args.selfReviewEnabled &&
      candidate.authorRef !== null &&
      candidate.authorRef === args.reviewerRef
    ) {
      excluded.push({ candidate, reason: 'authored_by_caller' });
      continue;
    }
    if (args.judged.has(formatVersionRef(candidate.version))) {
      excluded.push({ candidate, reason: 'already_judged' });
      continue;
    }
    eligible.push(candidate);
  }
  return { eligible, excluded };
}

/**
 * Merge eligible candidates into the served batch, honouring the reserves.
 *
 * Oldest first within each pool, and ties broken on the version reference so
 * that two rows created in the same millisecond do not swap places between
 * calls. A queue whose order is not stable makes every diagnostic comparing
 * two runs useless.
 */
export function selectReviewBatch(
  items: readonly ReviewCandidate[],
  limit: number,
  reserves: readonly TypeReserve[] = [],
): readonly ReviewCandidate[] {
  if (limit <= 0) return [];
  const byAge = (a: ReviewCandidate, b: ReviewCandidate): number =>
    a.createdAt.localeCompare(b.createdAt) ||
    formatVersionRef(a.version).localeCompare(formatVersionRef(b.version));

  const head: ReviewCandidate[] = [];
  const taken = new Set<ReviewCandidate>();
  for (const { targetType, fraction } of reserves) {
    const remaining = limit - head.length;
    if (remaining <= 0) break;
    const pool = items
      .filter((i) => i.target.type === targetType && !taken.has(i))
      .sort(byAge);
    const take = Math.min(pool.length, Math.ceil(limit * fraction), remaining);
    for (const item of pool.slice(0, take)) {
      head.push(item);
      taken.add(item);
    }
  }

  const rest = items.filter((i) => !taken.has(i)).sort(byAge);
  return [...head, ...rest].slice(0, limit);
}

/**
 * Which of these versions the reviewer has already formed a judgment on.
 *
 * One store call for the whole batch rather than one per row: a queue that
 * asks per candidate is how a listing endpoint becomes the slowest thing a
 * host serves.
 */
export async function judgedVersions(
  store: AssuranceStore,
  reviewerRef: string,
  candidates: readonly ReviewCandidate[],
): Promise<ReadonlySet<string>> {
  if (candidates.length === 0) return new Set();
  const assessments = await store.assessmentsByActor(
    reviewerRef,
    candidates.map((c) => c.version),
  );
  const judged = new Set<string>();
  for (const assessment of assessments) {
    // See the header: an implicit assessment is a stake in authorship, not a
    // judgment, and treating it as one makes a self-review grant useless.
    if (assessment.implicit) continue;
    judged.add(formatVersionRef(assessment.version));
  }
  return judged;
}

/**
 * The whole selection, from candidates to served batch.
 *
 * The pieces above stay individually exported because a host comparing a new
 * queue against an old one needs to see the exclusions, not just the result —
 * and because a host that already knows what a reviewer has judged should not
 * be made to ask again.
 */
export async function selectReviewQueue(args: {
  store: AssuranceStore;
  reviewerRef: string;
  candidates: readonly ReviewCandidate[];
  limit: number;
  selfReviewEnabled?: boolean;
  reserves?: readonly TypeReserve[];
}): Promise<ReviewQueueResult> {
  const judged = await judgedVersions(
    args.store,
    args.reviewerRef,
    args.candidates,
  );
  const { eligible, excluded } = filterEligible({
    candidates: args.candidates,
    reviewerRef: args.reviewerRef,
    ...(args.selfReviewEnabled === undefined
      ? {}
      : { selfReviewEnabled: args.selfReviewEnabled }),
    judged,
  });
  return {
    items: selectReviewBatch(eligible, args.limit, args.reserves ?? []),
    excluded,
    examined: args.candidates.length,
  };
}

/**
 * Candidates drawn from the store alone, for a host with no extra visibility
 * rule of its own.
 *
 * Every candidate comes back `visible: true`, which is the honest default only
 * because the store was asked for one space's open proposals and nothing else.
 * A host with per-row access control must build its own candidates: passing a
 * row through here and filtering afterwards would mean it had already been
 * counted as examined and, worse, that a future caller could skip the filter.
 */
export async function candidatesFromStore(
  store: AssuranceStore,
  space: SpaceId,
  query: { targetType?: TargetType; limit?: number } = {},
): Promise<readonly ReviewCandidate[]> {
  const proposals = await store.listOpenProposals(space, query);
  const candidates: ReviewCandidate[] = [];
  for (const proposal of proposals) {
    const version = await store.latestVersion(proposal.proposalId);
    // A proposal with no submitted version is not reviewable: there is nothing
    // to show. Skipped rather than shown as excluded, because it never became
    // a candidate in the first place.
    if (!version || version.submittedAt === null) continue;
    candidates.push({
      version: version.ref,
      target: version.target,
      createdAt: version.submittedAt,
      authorRef: proposal.author.actorRef,
      visible: true,
    });
  }
  return candidates;
}
