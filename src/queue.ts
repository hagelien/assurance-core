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

import type { AssuranceStore, StoredProposalVersion, Timestamp } from './store.js';
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
 * The most proposals one selection will read looking for `limit` eligible ones.
 *
 * A ceiling rather than a promise: a reviewer who has judged more than this
 * many of a space's oldest rows gets a short batch and a `truncated` flag, not
 * an unbounded scan. Overridable per call for a host whose backlog needs a
 * different one.
 */
export const MAX_CANDIDATE_WINDOW = 2000;

/** One read of the store, with what the caller needs to decide about reading more. */
interface CandidatePage {
  readonly candidates: readonly ReviewCandidate[];
  /** Open proposals the store returned, before any of them were dropped. */
  readonly examinedProposals: number;
  /** The store returned fewer proposals than asked for: there are no more. */
  readonly exhausted: boolean;
  /**
   * The creation time of the oldest proposal this page did **not** serve, or
   * of the last one it did when the space ran out first. Null for an empty
   * page.
   *
   * The store orders by proposal creation, so every proposal outside this page
   * was created at or after this instant — and a version is never submitted
   * before its proposal exists. So every unserved row's version is at least
   * this old, which is what lets the caller know when it has provably found
   * the oldest work without reading the whole backlog.
   */
  readonly readThrough: Timestamp | null;
}

async function candidatePage(
  store: AssuranceStore,
  space: SpaceId,
  query: { targetType?: TargetType; limit?: number },
  hydrated?: Map<string, StoredProposalVersion | null>,
): Promise<CandidatePage> {
  const { limit, ...narrowing } = query;
  // One row past the window, and only to answer "is there more?".
  //
  // A short page proves exhaustion; a full one does not, and the difference
  // matters exactly at the boundary. A space holding precisely `limit` open
  // proposals returns precisely `limit` rows, so without the sentinel it looks
  // identical to a space holding a million — and a caller at its cap would
  // report `truncated` over a backlog it had in fact read to the end, which is
  // the distinction this page exists to keep honest, inverted.
  const asked = limit === undefined ? narrowing : { ...narrowing, limit: limit + 1 };
  const read = await store.listOpenProposals(space, asked);
  const proposals = limit === undefined ? read : read.slice(0, limit);
  const candidates: ReviewCandidate[] = [];
  for (const proposal of proposals) {
    // Hydrated once per proposal across a growing window. Each growth re-reads
    // the prefix, and hydration is one `latestVersion` per row, so without the
    // cache a run to the default cap costs 100 + 200 + 400 + 800 + 1600 + 2000
    // sequential round trips against a store built for real latency.
    // `has`, not `?? await`: a proposal with no version caches as `null`, and
    // treating that as a miss re-fetched exactly the rows the cache was added
    // for — a backlog thick with unsubmitted proposals is what makes the window
    // grow in the first place.
    let version: StoredProposalVersion | null;
    if (hydrated?.has(proposal.proposalId)) {
      version = hydrated.get(proposal.proposalId) ?? null;
    } else {
      version = await store.latestVersion(proposal.proposalId);
      hydrated?.set(proposal.proposalId, version);
    }
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
  // The sentinel's own instant, when there is one, and the last row taken
  // otherwise. The sentinel is the oldest proposal this page did *not* serve,
  // so every row outside the page — the sentinel included — was created at or
  // after it, which is a weaker bar for a served item to clear than the last
  // taken row's. Reading the extra row and then discarding its timestamp cost
  // a whole doubling: with `limit` equal to the cap, a complete batch could
  // certify only `limit - 1` of its items and came back `truncated`.
  const boundary = read.at(limit === undefined ? -1 : limit) ?? proposals.at(-1);
  return {
    candidates,
    examinedProposals: proposals.length,
    // The sentinel decides this, not the candidate count. Distinguished from
    // "some rows were dropped" deliberately: a caller that grew its window on a
    // short *candidate* count alone would loop forever against a space whose
    // oldest rows have no submitted version.
    exhausted: limit === undefined || read.length <= limit,
    readThrough: boundary?.createdAt ?? null,
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
 *
 * `limit` is a count of *candidates*, not of rows read. A proposal with no
 * submitted version is not one, so asking for fifty and reading fifty rows
 * returns fewer than fifty whenever any of them is unsubmitted — a short page
 * that looks exactly like an exhausted backlog. The read window grows until
 * the count is met or the space runs out.
 *
 * This does not, and cannot, account for the reviewer's own eligibility: it
 * does not know who is asking. A queue served from these candidates has the
 * same shortfall one rule further on — see {@link selectReviewQueueFromStore},
 * which is the function to call when the reviewer is known.
 */
export async function candidatesFromStore(
  store: AssuranceStore,
  space: SpaceId,
  query: { targetType?: TargetType; limit?: number; maxCandidateWindow?: number } = {},
): Promise<readonly ReviewCandidate[]> {
  const { limit, maxCandidateWindow, ...narrowing } = query;
  if (limit === undefined) {
    return (await candidatePage(store, space, narrowing)).candidates;
  }
  // The cap is reached silently here: this returns no `truncated`, so a
  // clamped call is a short list with nothing to distinguish it from an
  // exhausted space. That is why {@link selectReviewQueueFromStore} exists for
  // the case where the answer has to say which of the two it is.
  const { value } = await overGrowingWindow(
    { store, space, narrowing, limit, maxCandidateWindow },
    (page) => ({
      settled: page.candidates.length >= limit,
      value: page.candidates.slice(0, limit),
    }),
  );
  return value;
}

/**
 * Read a growing prefix of a space until a caller-supplied rule settles.
 *
 * Both callers below need the same four things — a window clamped to the cap,
 * doubling, one hydration per proposal across the re-reads, and the cap
 * reported rather than hidden — and differ only in when they have enough.
 * Written out twice, they drifted twice: the hydration cache was added to one
 * and not the other, and so was the clamp, each shipping as its own defect in
 * a loop that already read correctly a few lines away. The stopping rule is
 * the part that genuinely differs, so it is the part that is passed in.
 *
 * `truncated` means the window reached the cap without settling, on a space
 * that had not run out — the batch is short because the search stopped, not
 * because there is no more work. A caller with nowhere to report that ignores
 * it, and says so where it does.
 */
async function overGrowingWindow<T>(
  args: {
    store: AssuranceStore;
    space: SpaceId;
    narrowing: { targetType?: TargetType };
    limit: number;
    maxCandidateWindow?: number | undefined;
  },
  attempt: (
    page: CandidatePage,
  ) => { settled: boolean; value: T } | Promise<{ settled: boolean; value: T }>,
): Promise<{ value: T; truncated: boolean }> {
  const cap = args.maxCandidateWindow ?? MAX_CANDIDATE_WINDOW;
  // Rejected rather than defaulted, and checked before any read. A ceiling
  // that is not a number makes every comparison below false — `NaN >= NaN` is
  // false, and so is the exhaustion test — so the loop grows a window of `NaN`
  // for ever, querying a store that answers nothing. A malformed numeric
  // config is a caller's bug either way; the difference is between an
  // exception naming the field and a request that never returns, and only one
  // of those can be found from a stack trace.
  // Integers, because both are counts of rows. A fractional window is
  // forwarded to `listOpenProposals` as a fractional `LIMIT`, which every
  // store answers differently and a SQL one rejects outright; a fractional
  // limit reaches `slice(0, 0.5)` and returns nothing while the loop believes
  // it settled. Neither is a number of rows anyone meant.
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError(
      `maxCandidateWindow must be an integer of at least 1, got ${String(
        args.maxCandidateWindow,
      )}`,
    );
  }
  if (!Number.isInteger(args.limit) || args.limit < 0) {
    throw new RangeError(
      `limit must be an integer of at least 0, got ${String(args.limit)}`,
    );
  }
  // Without this each growth re-reads the prefix and re-hydrates every row in
  // it, at one `latestVersion` apiece — 100 + 200 + 400 + … round trips
  // against a store built for real latency.
  const hydrated = new Map<string, StoredProposalVersion | null>();
  // `limit` rows to serve `limit`, but never past the cap. A caller asking for
  // more than the ceiling allows is asking for something the ceiling forbids,
  // and reading 10,000 rows because the limit said so would make the cap
  // decorative — it exists to bound the work one request can do.
  let window = Math.min(Math.max(args.limit, 1), cap);
  for (;;) {
    const page = await candidatePage(
      args.store,
      args.space,
      { ...args.narrowing, limit: window },
      hydrated,
    );
    const { settled, value } = await attempt(page);
    if (settled || page.exhausted) return { value, truncated: false };
    if (window >= cap) return { value, truncated: true };
    window = Math.min(window * 2, cap);
  }
}

/** What {@link selectReviewQueueFromStore} returns beyond the plain selection. */
export interface StoreReviewQueueResult extends ReviewQueueResult {
  /**
   * The window hit its cap before `limit` eligible rows were found, and the
   * space had not run out.
   *
   * A short batch with this false means there is no more work for this
   * reviewer. With it true the batch is short because the search stopped, and
   * the two must not be read the same way: one is an empty backlog, the other
   * is a backlog the queue gave up looking through.
   */
  readonly truncated: boolean;
}

/**
 * The whole selection, over a store, for a host with no visibility rule.
 *
 * Why this exists rather than "call `candidatesFromStore`, then
 * `selectReviewQueue`": those two apply the eligibility rules *after* the
 * store's `limit`, and the rules are what make the batch short. A reviewer who
 * has already judged the oldest `limit` rows of a space gets served nothing,
 * while an equivalent SQL queue — which puts author-exclusion and
 * already-judged inside its own query, ahead of its LIMIT — serves a full
 * batch from further back. That is not a formatting difference: it is one
 * queue showing a reviewer an empty backlog that another shows as full, and it
 * was found in production rather than in a test, because on a small database
 * the two agree.
 *
 * So the window grows — doubling, re-read from the start — until `limit`
 * eligible rows are in hand, the space runs out, or the cap is reached.
 * Re-reading the prefix costs at most one extra full read, which is what a
 * cursor would buy back; a cursor is also a second thing every store
 * implementation would have to get right, and `listOpenProposals` is
 * contractually oldest-first, so a growing prefix is stable: the row at
 * position n of the small window is at position n of the large one.
 *
 * `examined` and `excluded` describe the final window, not the sum of the
 * re-reads — a prefix read three times was not three candidates.
 */
export async function selectReviewQueueFromStore(args: {
  store: AssuranceStore;
  space: SpaceId;
  reviewerRef: string;
  limit: number;
  targetType?: TargetType;
  selfReviewEnabled?: boolean;
  reserves?: readonly TypeReserve[];
  maxCandidateWindow?: number;
}): Promise<StoreReviewQueueResult> {
  const narrowing = args.targetType === undefined ? {} : { targetType: args.targetType };
  const { value, truncated } = await overGrowingWindow(
    {
      store: args.store,
      space: args.space,
      narrowing,
      limit: args.limit,
      maxCandidateWindow: args.maxCandidateWindow,
    },
    async (page) => {
      const selection = await selectReviewQueue({
        store: args.store,
        reviewerRef: args.reviewerRef,
        candidates: page.candidates,
        limit: args.limit,
        ...(args.selfReviewEnabled === undefined
          ? {}
          : { selfReviewEnabled: args.selfReviewEnabled }),
        ...(args.reserves === undefined ? {} : { reserves: args.reserves }),
      });
      return { settled: settled(selection, page, args), value: selection };
    },
  );
  return { ...value, truncated };
}

/**
 * Whether this window has provably found the batch, or only filled it.
 *
 * Two things a full batch does not by itself establish, both of which cost
 * nothing to check and were wrong without the check.
 *
 * **The batch is the oldest work.** The store orders by proposal creation and
 * the batch orders by the current version's submission — different keys, and a
 * proposal revised after a newer one was submitted carries a version younger
 * than its position suggests. So a full window can hold `limit` recently
 * revised rows while an older *version* sits on a proposal just outside it.
 * What the store's ordering does guarantee is that every unread proposal was
 * created after `readThrough`, and no version predates its own proposal — so
 * an item submitted at or before `readThrough` cannot be beaten by anything
 * unread. Once `limit` of those are in hand the batch is settled; until then a
 * fuller window can still change it.
 *
 * **A reserve is met.** `selectReviewBatch` allocates the reserve out of the
 * candidates it is given, so a window whose first `limit` eligible rows are all
 * one type fills the batch and silently serves the reserved type nothing —
 * which is precisely the starvation reserves exist to prevent, arriving through
 * the stopping rule instead of the selection.
 */
function settled(
  selection: ReviewQueueResult,
  page: CandidatePage,
  args: { limit: number; reserves?: readonly TypeReserve[]; targetType?: TargetType },
): boolean {
  const through = page.readThrough;
  // Strictly older, not "at or older". At equality the guarantee runs out: an
  // unread proposal may share the boundary's `createdAt` and carry a version
  // submitted at that same instant, and the store contract promises oldest-first
  // without promising a tie-break that matches the batch's. So a tie is exactly
  // the case where an unread row could still sort ahead of a served one.
  //
  // The cost is a space whose rows all share one timestamp and outnumbers the
  // cap: it grows to the cap and says `truncated`, which is the honest answer,
  // because there it genuinely cannot prove the batch. Anything smaller runs
  // out first and settles on `exhausted`.
  const provable = selection.items.filter(
    (item) => through !== null && item.createdAt < through,
  );
  if (provable.length < args.limit) return false;
  // The same remaining-capacity rule `selectReviewBatch` allocates by, not the
  // raw fractions. Reserves may total more than one — 80% of A and 80% of B is
  // a legitimate way to say "mostly A, then B" — and the allocator gives the
  // first its eight slots and caps the second at the two left. Demanding both
  // full fractions here would scan to the cap and report `truncated` over a
  // batch the allocator considers finished.
  let remaining = args.limit;
  // What earlier entries already claimed of each type. The allocator excludes
  // items it has taken, so two 50% reserves on one type ask for ten between
  // them, not five twice — and comparing each entry against the type's whole
  // count settled on the first entry's worth.
  const claimed = new Map<TargetType, number>();
  for (const { targetType, fraction } of args.reserves ?? []) {
    if (remaining <= 0) break;
    // A reserve for a type the query cannot return is not unmet, it is
    // inapplicable: narrowing to notes and reserving records, the store will
    // never produce one however far the window grows, so waiting for it means
    // scanning to the cap and calling a complete batch truncated.
    if (args.targetType !== undefined && targetType !== args.targetType) continue;
    const want = Math.min(Math.ceil(args.limit * fraction), remaining);
    const already = claimed.get(targetType) ?? 0;
    const have =
      provable.filter((i) => i.target.type === targetType).length - already;
    if (have < want) return false;
    claimed.set(targetType, already + want);
    remaining -= want;
  }
  return true;
}
