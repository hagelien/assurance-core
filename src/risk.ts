/**
 * Risk vocabulary for the governance core.
 *
 * The core cannot classify risk, and should not try: judging how consequential
 * a change is requires knowing what the subject matter means. The host's
 * target adapter produces a `RiskProfile`; policy rules here only ever match
 * on the level and the tags.
 */

/**
 * Ordered from least to most consequential. The ordering matters: rules match
 * with "at least this level", so adding a level between two existing ones is a
 * breaking change to every policy that referenced them and needs a new policy
 * version.
 */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * A host's risk classification of one proposal version.
 *
 * `tags` are free-form host vocabulary — whatever distinctions its domain
 * actually makes. They let a policy express a requirement the coarse level
 * cannot: "a change of this particular kind needs a human expert in it" is a
 * tag rule, not a level rule, and no amount of level granularity would say it
 * as well.
 */
export interface RiskProfile {
  readonly level: RiskLevel;
  readonly tags: readonly string[];
}

/** The default classification for anything a host has not classified. */
export const LOW_RISK: RiskProfile = Object.freeze({
  level: 'low' as RiskLevel,
  tags: Object.freeze([]) as readonly string[],
});

/** Build a `RiskProfile`, normalising tags to a fresh array. */
export function riskProfile(
  level: RiskLevel,
  tags: readonly string[] = [],
): RiskProfile {
  return { level, tags: [...tags] };
}

/** True when `value` is one of the known levels. Unknown input is not a level. */
export function isRiskLevel(value: unknown): value is RiskLevel {
  return (
    typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * True when `profile` is at least as consequential as `minimum`. This is the
 * comparison policy rules use, so `when({ risk: 'medium' })` also catches
 * `high` — a rule written for medium risk must never silently stop applying to
 * something riskier.
 */
export function atLeastRisk(profile: RiskProfile, minimum: RiskLevel): boolean {
  return RISK_RANK[profile.level] >= RISK_RANK[minimum];
}

/** True when the host tagged this profile with `tag`. */
export function hasRiskTag(profile: RiskProfile, tag: string): boolean {
  return profile.tags.includes(tag);
}

/** Rank of a level, for host code that needs to sort or compare directly. */
export function riskRank(level: RiskLevel): number {
  return RISK_RANK[level];
}
