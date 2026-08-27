/**
 * Requirement primitives — the composable units a policy is built from.
 *
 * A requirement is a pure, deterministic predicate over a `PolicyContext` that
 * explains itself. Three properties are non-negotiable, and they are why this
 * is a small closed set of constructors rather than an "accepts any predicate"
 * interface:
 *
 *  - **Deterministic.** No clock, no randomness, no I/O. Evaluating the same
 *    context twice must give the same answer, or a decision record cannot be
 *    audited later.
 *  - **Explainable.** An unmet requirement carries a stable id and a
 *    human-readable description, so a held proposal can say *why* it is held.
 *  - **No model judgment inside the gate.** Nothing here asks a model whether
 *    something looks right. Requirements count recorded facts.
 *
 * Requirement ids are stable strings and are part of the compatibility
 * surface: host code maps them back onto its own vocabulary, and stored
 * decision records name them. Renaming one is a breaking change.
 */

import type { PolicyContext } from './policy.js';
import type { PolicyRuleId, RequirementId } from './types.js';

/** The verdict on one requirement for one context. */
export interface RequirementOutcome {
  readonly requirementId: RequirementId;
  /** The rule that contributed this requirement; filled in by policy evaluation. */
  readonly ruleId?: PolicyRuleId;
  readonly met: boolean;
  /** Stable human-readable statement of what the requirement demands. */
  readonly description: string;
  /** Why it was (not) met, in terms of the actual context. */
  readonly detail?: string;
}

/** A composable, self-describing publication requirement. */
export interface Requirement {
  readonly id: RequirementId;
  /** Constructor arguments, for serialising a policy set into a decision record. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly describe: () => string;
  readonly evaluate: (context: PolicyContext) => RequirementOutcome;
}

/** Stable ids of every primitive in this module. */
export const REQUIREMENT_IDS = {
  independentApprovals: 'assurance.independentApprovals',
  independentApprovalsFromPool: 'assurance.independentApprovals.pool',
  noDisputingAssessments: 'assurance.noDisputingAssessments',
  noOpenDisputes: 'disputes.none',
  approvalWithCapability: 'assurance.approvalWithCapability',
  humanApproval: 'assurance.humanApproval',
  humanApprovalWithCapability: 'assurance.humanApprovalWithCapability',
  evidenceRequirementsSatisfied: 'evidence.allSatisfied',
} as const;

function requirement(args: {
  id: RequirementId;
  params: Record<string, unknown>;
  description: string;
  check: (context: PolicyContext) => { met: boolean; detail: string };
}): Requirement {
  return {
    id: args.id,
    params: Object.freeze({ ...args.params }),
    describe: () => args.description,
    evaluate: (context) => {
      const { met, detail } = args.check(context);
      return {
        requirementId: args.id,
        met,
        description: args.description,
        detail,
      };
    },
  };
}

/**
 * At least `count` approvals from assessors other than the author.
 *
 * Use this when the number is a fixed integrity target that must not bend to a
 * small reviewer pool — a high-risk change that should wait rather than
 * publish under a relaxed bar. For the pool-adapted number, use
 * `independentApprovalsFromPool`.
 */
export function independentApprovals(count: number): Requirement {
  return requirement({
    id: REQUIREMENT_IDS.independentApprovals,
    params: { count },
    description: `at least ${count} independent approval(s)`,
    check: (context) => ({
      met: context.assurance.independentApprovers >= count,
      detail: `${context.assurance.independentApprovers} of ${count} independent approval(s)`,
    }),
  });
}

/**
 * At least the reviewer pool's *effective* quorum in independent approvals.
 *
 * This is the requirement that keeps a small deployment moving: a fixed target
 * larger than the pool is unreachable, and an unreachable requirement does not
 * fail loudly — proposals just accumulate unreviewed. `ReviewerPoolState`
 * carries `degraded` so the relaxation is observable rather than silent.
 */
export function independentApprovalsFromPool(): Requirement {
  return requirement({
    id: REQUIREMENT_IDS.independentApprovalsFromPool,
    params: {},
    description: 'at least the reviewer pool’s effective quorum in independent approvals',
    check: (context) => ({
      met: context.assurance.independentApprovers >= context.pool.effectiveQuorum,
      detail:
        `${context.assurance.independentApprovers} of ${context.pool.effectiveQuorum} ` +
        `independent approval(s)` +
        (context.pool.degraded
          ? ` (pool degraded from a design target of ${context.pool.designTargetQuorum})`
          : ''),
    }),
  });
}

/**
 * No reviewer holds an explicit `dispute` verdict.
 *
 * One reasoned contradiction holds the proposal however many approvals it
 * carries: approvals and disputes are not netted off against each other. A
 * reviewer that found a real problem is not outvoted by reviewers who did not
 * look for one.
 */
export function noDisputingAssessments(): Requirement {
  return requirement({
    id: REQUIREMENT_IDS.noDisputingAssessments,
    params: {},
    description: 'no reviewer holds a dispute verdict',
    check: (context) => ({
      met: context.assurance.disputingAssessors === 0,
      detail: `${context.assurance.disputingAssessors} disputing assessor(s)`,
    }),
  });
}

/**
 * No open dispute record. Distinct from `noDisputingAssessments`: a dispute
 * record is a formal objection with its own lifecycle (open → upheld /
 * rejected / withdrawn) that anyone may raise, including someone who never
 * cast an assessment.
 */
export function noOpenDisputes(): Requirement {
  return requirement({
    id: REQUIREMENT_IDS.noOpenDisputes,
    params: {},
    description: 'no open dispute',
    check: (context) => ({
      met: context.assurance.disputesOpen === 0,
      detail: `${context.assurance.disputesOpen} open dispute(s)`,
    }),
  });
}

/**
 * At least one approval cast by an assessor carrying `capability` as a
 * server-owned assurance property.
 *
 * The capability is read from the snapshot taken when the assessment was
 * recorded, never from the assessor's current state and never from anything
 * the assessor reported about itself.
 */
export function approvalWithCapability(capability: string): Requirement {
  return requirement({
    id: REQUIREMENT_IDS.approvalWithCapability,
    params: { capability },
    description: `at least one approval from an assessor with '${capability}'`,
    check: (context) => ({
      met: context.assurance.approvalCapabilities.includes(capability),
      detail: context.assurance.approvalCapabilities.includes(capability)
        ? `an approval carries '${capability}'`
        : `no approval carries '${capability}'`,
    }),
  });
}

/**
 * At least one approval from a person.
 *
 * `service` and `system` actors do not satisfy this, by construction — the
 * requirement exists to put a human in the loop, and an automated pipeline
 * standing in for one defeats the whole point.
 */
export function humanApproval(): Requirement {
  return requirement({
    id: REQUIREMENT_IDS.humanApproval,
    params: {},
    description: 'at least one approval from a human',
    check: (context) => ({
      met: context.assurance.humanApprovals >= 1,
      detail: `${context.assurance.humanApprovals} human approval(s)`,
    }),
  });
}

/**
 * At least one approval from a person who holds `capability`.
 *
 * Deliberately not `humanApproval()` + `approvalWithCapability(cap)`: that pair
 * is satisfiable by two different actors — an unqualified human plus a
 * qualified agent — which is not what "a qualified person signed this off"
 * means.
 */
export function humanApprovalWithCapability(capability: string): Requirement {
  return requirement({
    id: REQUIREMENT_IDS.humanApprovalWithCapability,
    params: { capability },
    description: `at least one approval from a human with '${capability}'`,
    check: (context) => ({
      met: context.assurance.humanApprovalCapabilities.includes(capability),
      detail: context.assurance.humanApprovalCapabilities.includes(capability)
        ? `a human approval carries '${capability}'`
        : `no human approval carries '${capability}'`,
    }),
  });
}

/** Every evidence requirement the host declared for this proposal is satisfied. */
export function evidenceRequirementsSatisfied(): Requirement {
  return requirement({
    id: REQUIREMENT_IDS.evidenceRequirementsSatisfied,
    params: {},
    description: 'every declared evidence requirement is satisfied',
    check: (context) => {
      const states = context.assurance.evidenceRequirementState;
      const unsatisfied = states.filter((s) => !s.satisfied);
      return {
        met: unsatisfied.length === 0,
        detail:
          unsatisfied.length === 0
            ? `${states.length} evidence requirement(s) satisfied`
            : `unsatisfied: ${unsatisfied.map((s) => s.requirementId).join(', ')}`,
      };
    },
  });
}
