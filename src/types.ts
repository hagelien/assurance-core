/**
 * Shared vocabulary for the governance core.
 *
 * These are the *policy concepts*, deliberately separated from anyone's
 * persistence. Nothing here may reach for a database driver, a UI framework,
 * an HTTP request object, or any concept belonging to a particular field of
 * knowledge. The test is simple: if a symbol needs to know what a specific
 * domain term means, it belongs in the host, not in this package.
 *
 * Identifiers are strings rather than numbers throughout. A host whose rows
 * are integer-keyed will find that slightly lossy, and it is the right trade:
 * the core must not assume a governed object is addressable by an integer in
 * every store. The host stringifies on the way in and parses on the way out.
 */

/**
 * A governed knowledge collection. A host may run one or several. The space
 * exists so domain assumptions do not leak into primary keys and policy
 * configuration — it is deliberately not full multi-tenancy.
 */
export type SpaceId = string;

/**
 * The host's name for a kind of governed object (`wiki_fact`, `param_entry`,
 * …). The core treats it as an opaque key into the host's adapter registry.
 */
export type TargetType = string;

/** Address of one governed object within a space. */
export interface TargetRef {
  readonly space: SpaceId;
  readonly type: TargetType;
  readonly id: string;
}

/**
 * Address of one immutable proposed change to a target. A proposal may have
 * several versions over its life (returned, revised, resubmitted); governance
 * decisions always name the version they were made against, never the
 * proposal, so a later revision can never inherit an earlier version's
 * approvals.
 */
export interface ProposalVersionRef {
  readonly proposalId: string;
  readonly versionId: string;
}

/**
 * Stable content hash of a payload, produced by the host's target adapter.
 * The core only ever compares fingerprints for equality; it never interprets
 * them, and it does not care which algorithm produced one.
 */
export type Fingerprint = string;

/** Stable identifier of one requirement primitive, e.g. `assurance.independentApprovals`. */
export type RequirementId = string;

/** Stable identifier of one policy rule within a policy set. */
export type PolicyRuleId = string;

/** Stable identifier of a policy set, e.g. `editorial-consensus`. */
export type PolicyId = string;

/**
 * Version of a policy set. Every authoritative decision records the exact
 * version it was made under, so a later policy change cannot retroactively
 * imply that older content was published under the new rule.
 */
export type PolicyVersion = string;

/** Build a `TargetRef` without repeating the field names at every call site. */
export function targetRef(
  space: SpaceId,
  type: TargetType,
  id: string,
): TargetRef {
  return { space, type, id };
}

/** Canonical string form of a target, for logs and map keys. */
export function formatTargetRef(ref: TargetRef): string {
  return `${ref.space}/${ref.type}/${ref.id}`;
}
