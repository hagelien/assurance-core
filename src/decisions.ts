/**
 * Decision records: the auditable output of evaluating a policy set.
 *
 * Every authoritative decision records the exact
 * policy version it was made under, so a later policy change cannot
 * retroactively imply that older content was published under the new rule. The
 * record therefore carries the policy id, its version, a fingerprint of the
 * inputs, and the full satisfied/unmet requirement breakdown — enough to
 * re-explain the decision without the original context still being in hand.
 */

import type { PolicyContext } from './policy.js';
import type { RequirementOutcome } from './requirements.js';
import type { Fingerprint, PolicyId, PolicyRuleId, PolicyVersion } from './types.js';

/** The result of evaluating one policy set against one context. */
export interface PolicyDecision {
  /** True when every applicable requirement was met. */
  readonly allowed: boolean;
  readonly policyId: PolicyId;
  readonly policyVersion: PolicyVersion;
  /** Stable hash of the evaluated context; equal fingerprints mean equal inputs. */
  readonly inputFingerprint: Fingerprint;
  /** Rules that applied, in evaluation order. */
  readonly matchedRuleIds: readonly PolicyRuleId[];
  /** Every requirement evaluated, in evaluation order. */
  readonly outcomes: readonly RequirementOutcome[];
  /** The subset of `outcomes` that failed, in evaluation order. */
  readonly unmet: readonly RequirementOutcome[];
}

/**
 * Deterministic JSON of an arbitrary value: object keys sorted at every depth,
 * so two structurally equal contexts always serialise identically regardless of
 * the order their fields happened to be built in.
 *
 * `undefined` object properties are dropped (matching `JSON.stringify`), so an
 * absent field and an explicitly-undefined one fingerprint the same.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}

/**
 * FNV-1a, run twice with different offset bases and concatenated to 16 hex
 * characters.
 *
 * Deliberately **not** cryptographic and deliberately not `node:crypto`: this
 * module is bundled into the browser build, and the fingerprint's only job is
 * change detection and audit correlation ("were these the same inputs?"). It is
 * never a security boundary — nothing is authorised by matching a fingerprint.
 */
function fnv1aHex(input: string, offsetBasis: number): string {
  let hash = offsetBasis;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // 16777619, as shifts — Math.imul keeps this exact in 32-bit space.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Stable, non-cryptographic fingerprint of any deterministically-serialisable value. */
export function fingerprint(value: unknown): Fingerprint {
  const json = stableStringify(value);
  return `${fnv1aHex(json, 0x811c9dc5)}${fnv1aHex(json, 0x9e3779b9)}`;
}

/** Canonical ordering for an array the policy only ever reads by membership. */
function canonicalSet(values: readonly string[]): string[] {
  return [...values].sort();
}

/**
 * Fingerprint the governance-relevant parts of a policy context.
 *
 * Only the fields policy evaluation may read are hashed. Audit-only metadata is
 * excluded on purpose: were it included, two decisions made on identical
 * governance facts would fingerprint differently because an unrelated note
 * changed, which destroys the "same inputs → same fingerprint" property the
 * record depends on.
 *
 * Every array the policy consults by membership rather than by position is
 * sorted first, for the same reason. Risk tags, approval capabilities and actor
 * capabilities are sets: `matchesRule` and `approvalWithCapability` use
 * `.includes()`, so reordering one cannot change a decision — and must not
 * change its fingerprint either, or parity tooling reports differing inputs for
 * an identical governance decision. `tallyAssurance` already sorts what it
 * produces; this covers profiles a host assembled by hand rather than through
 * the tally, which a legacy projection path may well do.
 *
 * `evidenceRequirementState` is deliberately NOT sorted: its order is
 * observable in `evidenceRequirementsSatisfied`'s outcome detail, so it is a
 * sequence the host chose rather than a set, and canonicalising it here would
 * hash two contexts that explain themselves differently to the same value.
 */
export function fingerprintPolicyContext(context: PolicyContext): Fingerprint {
  return fingerprint({
    space: context.space,
    targetType: context.targetType,
    proposalVersionId: context.proposalVersionId,
    author: {
      actorRef: context.author.actorRef,
      kind: context.author.kind,
      capabilities: canonicalSet(context.author.capabilities),
      assuranceCapabilities: canonicalSet(context.author.assuranceCapabilities),
    },
    risk: { level: context.risk.level, tags: canonicalSet(context.risk.tags) },
    assurance: {
      ...context.assurance,
      approvalCapabilities: canonicalSet(context.assurance.approvalCapabilities),
      humanApprovalCapabilities: canonicalSet(
        context.assurance.humanApprovalCapabilities,
      ),
    },
    pool: context.pool,
    flags: canonicalSet(context.flags),
  });
}

/** One-line summary of a decision, for logs. */
export function describeDecision(decision: PolicyDecision): string {
  if (decision.allowed) {
    return `${decision.policyId}@${decision.policyVersion}: allowed`;
  }
  const reasons = decision.unmet
    .map((o) => `${o.requirementId} (${o.detail ?? o.description})`)
    .join('; ');
  return `${decision.policyId}@${decision.policyVersion}: held — ${reasons}`;
}

/** The first unmet requirement, or `null` when the decision allows publication. */
export function firstUnmet(decision: PolicyDecision): RequirementOutcome | null {
  return decision.unmet[0] ?? null;
}
