/**
 * Actor model for the governance core.
 *
 * The core authenticates nobody. The host resolves the caller and hands down
 * an `ActorContext`; the core only ever reads it. Two properties of that
 * contract are load-bearing, and the type split below is what enforces them:
 *
 *  - `capabilities` are the host's permission-matrix answers — whatever its
 *    equivalent of `can(role, action)` returns. They gate *actions*.
 *  - `assuranceCapabilities` are **server-owned** properties that may gate a
 *    *publication requirement*. The distinction is a security boundary, not a
 *    naming convention: a value the caller could have chosen must never appear
 *    here, or an actor can satisfy a requirement by asserting that it does.
 *    A self-reported model string is audit metadata; the tier a server
 *    recorded for that verifier is an assurance capability. See
 *    `modelTierCapability` below.
 */

/**
 * What kind of thing is acting. A host must derive this server-side — from its
 * own record of who the authenticated principal is — and never from a claim in
 * the request payload.
 */
export type ActorKind = 'human' | 'agent' | 'service' | 'system';

/** The caller as the host resolved it. */
export interface ActorContext {
  /** Host-opaque stable identity, e.g. `user:42`. */
  readonly actorRef: string;
  readonly kind: ActorKind;
  /** Action capabilities from the host's permission matrix. */
  readonly capabilities: readonly string[];
  /** Server-owned properties that may satisfy a publication requirement. */
  readonly assuranceCapabilities?: readonly string[];
  /** Audit-only. Never consulted by policy evaluation. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * The subset of an actor a policy is allowed to see. `metadata` is dropped on
 * purpose: it carries self-reported values (the model string an agent claims
 * to be running), and the gate must not be able to read them even by accident.
 */
export interface ActorSnapshot {
  readonly actorRef: string;
  readonly kind: ActorKind;
  readonly capabilities: readonly string[];
  readonly assuranceCapabilities: readonly string[];
}

/** Prefix for the server-owned model-tier assurance capability. */
export const MODEL_TIER_CAPABILITY_PREFIX = 'model_tier:';

/**
 * The assurance capability naming a verifier's server-owned tier.
 *
 * Build this from a tier the server recorded at the moment the assessment was
 * written — snapshotted with the verdict, so a later change to the actor's
 * registration cannot retroactively alter what its past reviews were worth.
 * Never from a mutable row read at evaluation time, and never from the
 * caller's payload.
 */
export function modelTierCapability(tier: string): string {
  return `${MODEL_TIER_CAPABILITY_PREFIX}${tier}`;
}

/**
 * Project a full actor context down to what policy evaluation may read.
 * Deterministic: capability order is preserved, absent assurance capabilities
 * become an empty list rather than `undefined`, so two snapshots of the same
 * actor always fingerprint identically.
 */
export function snapshotActor(actor: ActorContext): ActorSnapshot {
  return {
    actorRef: actor.actorRef,
    kind: actor.kind,
    capabilities: [...actor.capabilities],
    assuranceCapabilities: [...(actor.assuranceCapabilities ?? [])],
  };
}

/** True when the actor holds `capability` in the host's permission matrix. */
export function hasCapability(
  actor: Pick<ActorSnapshot, 'capabilities'>,
  capability: string,
): boolean {
  return actor.capabilities.includes(capability);
}

/** True when the actor carries `capability` as a server-owned assurance property. */
export function hasAssuranceCapability(
  actor: Pick<ActorSnapshot, 'assuranceCapabilities'>,
  capability: string,
): boolean {
  return actor.assuranceCapabilities.includes(capability);
}

/** True when the actor is a registered agent rather than a person. */
export function isAgentActor(actor: Pick<ActorSnapshot, 'kind'>): boolean {
  return actor.kind === 'agent';
}

/**
 * True when a person is acting. `service` and `system` are deliberately NOT
 * human: an automated migration or a scheduled job must never satisfy a
 * requirement that exists to put a person in the loop.
 */
export function isHumanActor(actor: Pick<ActorSnapshot, 'kind'>): boolean {
  return actor.kind === 'human';
}
