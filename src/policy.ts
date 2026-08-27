/**
 * The policy engine: a small deterministic composition API, not a rules
 * language.
 *
 * Deliberately not a dynamic rules interpreter fed by JSON. Rules stay in
 * TypeScript so they are type-checked, reviewable in a diff, and hard to
 * weaken by accident through malformed runtime configuration. The cost is that
 * changing a rule needs a deploy; that is the intended trade.
 *
 * Matchers are declarative objects rather than arbitrary predicates for the
 * same reason. A closure can read anything, cannot be serialised into a
 * decision record, and cannot be explained back to a user — all three are
 * requirements here.
 */

import { atLeastRisk, isRiskLevel, type RiskLevel, type RiskProfile } from './risk.js';
import type { ActorKind, ActorSnapshot } from './actors.js';
import type { AssuranceProfile, ReviewerPoolState } from './assurance.js';
import { fingerprintPolicyContext, type PolicyDecision } from './decisions.js';
import type { Requirement, RequirementOutcome } from './requirements.js';
import type {
  PolicyId,
  PolicyRuleId,
  PolicyVersion,
  SpaceId,
  TargetType,
} from './types.js';

/**
 * The normalized facts a policy is allowed to see. Nothing domain-specific
 * appears here: the core never learns what the change actually says, only that
 * the host classified it at some risk level and attached some tags. Everything
 * a rule may consider has already been reduced to that vocabulary.
 */
export interface PolicyContext {
  readonly space: SpaceId;
  readonly targetType: TargetType;
  readonly proposalVersionId: string;
  readonly author: ActorSnapshot;
  readonly risk: RiskProfile;
  readonly assurance: AssuranceProfile;
  readonly pool: ReviewerPoolState;
  /** Host-supplied switches (e.g. a migration mode). Matched, never interpreted. */
  readonly flags: readonly string[];
}

/**
 * A declarative rule condition. Every present field must match (AND); an empty
 * or absent matcher means the rule always applies.
 */
export interface RuleMatcher {
  /** Matches when the author's kind is this one, or one of these. */
  readonly authorKind?: ActorKind | readonly ActorKind[];
  readonly targetType?: TargetType | readonly TargetType[];
  /**
   * Minimum risk level. `'medium'` also matches `'high'`: a rule written for a
   * risk floor must never stop applying to something riskier.
   */
  readonly risk?: RiskLevel;
  /** Every listed tag must be present on the risk profile. */
  readonly riskTags?: readonly string[];
  /** Every listed flag must be present on the context. */
  readonly flags?: readonly string[];
}

export interface PolicyRule {
  readonly id: PolicyRuleId;
  /** `null` for an unconditional rule. */
  readonly when: RuleMatcher | null;
  readonly requirements: readonly Requirement[];
  /** True for a rule registered via `.otherwise()`. */
  readonly isFallback: boolean;
}

export interface PolicySet {
  readonly id: PolicyId;
  readonly version: PolicyVersion;
  readonly rules: readonly PolicyRule[];
  readonly evaluate: (context: PolicyContext) => PolicyDecision;
  /** Serialisable description of every rule, for decision records and docs. */
  readonly describe: () => ReadonlyArray<{
    ruleId: PolicyRuleId;
    when: RuleMatcher | null;
    isFallback: boolean;
    requirements: ReadonlyArray<{ id: string; description: string; params: Record<string, unknown> }>;
  }>;
}

function toArray<T>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? (value as readonly T[]) : ([value] as readonly T[]);
}

/** True when every present field of `matcher` holds for `context`. */
export function matchesRule(
  matcher: RuleMatcher | null,
  context: PolicyContext,
): boolean {
  if (!matcher) return true;

  const authorKinds = toArray(matcher.authorKind);
  if (authorKinds && !authorKinds.includes(context.author.kind)) return false;

  const targetTypes = toArray(matcher.targetType);
  if (targetTypes && !targetTypes.includes(context.targetType)) return false;

  if (matcher.risk !== undefined) {
    // An unknown level in a matcher must not silently match everything.
    if (!isRiskLevel(matcher.risk)) return false;
    if (!atLeastRisk(context.risk, matcher.risk)) return false;
  }

  if (matcher.riskTags) {
    for (const tag of matcher.riskTags) {
      if (!context.risk.tags.includes(tag)) return false;
    }
  }

  if (matcher.flags) {
    for (const flag of matcher.flags) {
      if (!context.flags.includes(flag)) return false;
    }
  }

  return true;
}

/**
 * True when the matcher actually constrains anything.
 *
 * An empty `riskTags`/`flags` list constrains nothing — "every tag in []" is
 * vacuously true — so it is not a constraint. An empty `authorKind`/
 * `targetType` list is the opposite: "the kind is one of []" can never hold, so
 * it is a never-match rule and very much a constraint.
 */
function constrainsAnything(matcher: RuleMatcher): boolean {
  if (matcher.authorKind !== undefined) return true;
  if (matcher.targetType !== undefined) return true;
  if (matcher.risk !== undefined) return true;
  if (matcher.riskTags && matcher.riskTags.length > 0) return true;
  if (matcher.flags && matcher.flags.length > 0) return true;
  return false;
}

/** Deep-freeze a copy of a matcher, so a later mutation of the caller's object cannot reach the built policy. */
function freezeMatcher(matcher: RuleMatcher): RuleMatcher {
  const { authorKind, targetType } = matcher;
  return Object.freeze({
    authorKind: Array.isArray(authorKind)
      ? (Object.freeze([...(authorKind as readonly ActorKind[])]) as readonly ActorKind[])
      : (authorKind as ActorKind | undefined),
    targetType: Array.isArray(targetType)
      ? (Object.freeze([...(targetType as readonly TargetType[])]) as readonly TargetType[])
      : (targetType as TargetType | undefined),
    risk: matcher.risk,
    riskTags: matcher.riskTags ? Object.freeze([...matcher.riskTags]) : undefined,
    flags: matcher.flags ? Object.freeze([...matcher.flags]) : undefined,
  });
}

/**
 * Reduce a rule's `when` to its canonical form.
 *
 * A matcher that constrains nothing becomes `null` — the same representation an
 * omitted `when` gets. The two forms are documented as equivalent, and without
 * this they were not: `when: {}` counted as a matched *conditional* rule and so
 * suppressed every `.otherwise()` rule, while omitting `when` did not. That
 * divergence dropped the fallback's requirements, which is the fail-open
 * direction — exactly the way a governance gate must never differ by accident.
 */
function normalizeMatcher(matcher: RuleMatcher | undefined): RuleMatcher | null {
  if (!matcher || !constrainsAnything(matcher)) return null;
  return freezeMatcher(matcher);
}

export interface RuleSpec {
  readonly id: PolicyRuleId;
  /** Omit for a rule that always applies. */
  readonly when?: RuleMatcher;
  readonly require: readonly Requirement[];
}

export interface PolicyBuilder {
  /** Add a rule. Omitting `when` makes it unconditional. */
  rule(spec: RuleSpec): PolicyBuilder;
  /**
   * Add a fallback rule, applied only when **no conditional rule matched**.
   *
   * Unconditional rules (`rule()` without `when`) do not suppress the fallback:
   * they are the baseline every proposal must clear, so treating one as "a rule
   * matched" would make `otherwise` unreachable in any policy that has a
   * baseline — which is every policy worth writing.
   */
  otherwise(spec: RuleSpec): PolicyBuilder;
  build(): PolicySet;
}

/**
 * Start building a policy set.
 *
 * Rule ids are supplied explicitly rather than derived from position, because
 * they end up in persisted decision records: a positional id would silently
 * re-point at a different rule the moment someone reorders the file, and every
 * historical record referencing it would start explaining the wrong thing.
 */
export function policy(id: PolicyId, version: PolicyVersion): PolicyBuilder {
  const rules: PolicyRule[] = [];

  const assertUniqueId = (ruleId: PolicyRuleId) => {
    if (rules.some((r) => r.id === ruleId)) {
      throw new Error(
        `knowledge-governance: duplicate rule id '${ruleId}' in policy '${id}'`,
      );
    }
  };

  const builder: PolicyBuilder = {
    rule(spec) {
      assertUniqueId(spec.id);
      rules.push({
        id: spec.id,
        when: normalizeMatcher(spec.when),
        requirements: Object.freeze([...spec.require]),
        isFallback: false,
      });
      return builder;
    },
    otherwise(spec) {
      assertUniqueId(spec.id);
      rules.push({
        id: spec.id,
        when: null,
        requirements: Object.freeze([...spec.require]),
        isFallback: true,
      });
      return builder;
    },
    build() {
      // Freeze the whole graph the built set exposes, not just each rule
      // object: `rules` is handed out as `PolicySet.rules` AND captured by
      // `evaluate`, so an unfrozen array would let a consumer splice rules into
      // an already-versioned policy and silently change what it requires while
      // persisted decisions still name the old version. `.map()` also snapshots
      // away from the builder's live array, so a `.rule()` call after `build()`
      // cannot reach a set already built. (Matchers and requirement lists were
      // copied and frozen on the way in.)
      const frozen: readonly PolicyRule[] = Object.freeze(
        rules.map((r) => Object.freeze(r)),
      );
      return Object.freeze({
        id,
        version,
        rules: frozen,
        evaluate: (context: PolicyContext) => evaluatePolicy(id, version, frozen, context),
        describe: () =>
          frozen.map((r) => ({
            ruleId: r.id,
            when: r.when,
            isFallback: r.isFallback,
            requirements: r.requirements.map((req) => ({
              id: req.id,
              description: req.describe(),
              params: { ...req.params },
            })),
          })),
      });
    },
  };

  return builder;
}

/**
 * Evaluate every applicable rule and collect the outcomes.
 *
 * Order is fixed and is part of the contract, because host code maps the
 * *first* unmet requirement onto its own hold reason:
 *
 *   1. unconditional rules, in declaration order;
 *   2. matching conditional rules, in declaration order;
 *   3. the fallback rule, only when no conditional rule matched.
 *
 * Requirements inside a rule keep their declaration order. Every applicable
 * requirement is evaluated even once one has failed — a proposal held for three
 * reasons should be able to say all three, so the author fixes them in one pass
 * instead of three round-trips.
 */
function evaluatePolicy(
  id: PolicyId,
  version: PolicyVersion,
  rules: readonly PolicyRule[],
  context: PolicyContext,
): PolicyDecision {
  const applicable: PolicyRule[] = [];
  let anyConditionalMatched = false;

  for (const rule of rules) {
    if (rule.isFallback || rule.when !== null) continue;
    applicable.push(rule);
  }
  for (const rule of rules) {
    if (rule.isFallback || rule.when === null) continue;
    if (matchesRule(rule.when, context)) {
      anyConditionalMatched = true;
      applicable.push(rule);
    }
  }
  if (!anyConditionalMatched) {
    for (const rule of rules) {
      if (rule.isFallback) applicable.push(rule);
    }
  }

  const outcomes: RequirementOutcome[] = [];
  for (const rule of applicable) {
    for (const requirement of rule.requirements) {
      outcomes.push({ ...requirement.evaluate(context), ruleId: rule.id });
    }
  }
  const unmet = outcomes.filter((o) => !o.met);

  return Object.freeze({
    allowed: unmet.length === 0,
    policyId: id,
    policyVersion: version,
    inputFingerprint: fingerprintPolicyContext(context),
    matchedRuleIds: applicable.map((r) => r.id),
    outcomes,
    unmet,
  });
}
