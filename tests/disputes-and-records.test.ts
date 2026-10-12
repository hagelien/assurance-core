/**
 * What 0.5 added to the kernel, each with the failure it exists for.
 *
 * - An upheld dispute keeps holding a version: closing an objection and
 *   finding it correct are different facts.
 * - A stored decision keeps why it was taken, and which definition of the
 *   policy it was taken under.
 * - A shadow decision can be compared with what actually happened, in the
 *   direction that matters.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_ASSURANCE_PROFILE,
  MemoryAssuranceStore,
  compareShadowDecision,
  decisionRecord,
  disputeIsUpheld,
  fingerprintPolicyContext,
  formatVersionRef,
  humanApproval,
  independentApprovals,
  noOpenDisputes,
  noUpheldDisputes,
  policy,
  tallyAssurance,
  type AssuranceProfile,
} from '../src/index.js';
import { makeContext } from './support/policy-context.js';

const T0 = '2020-01-01T00:00:00.000Z';
const T1 = '2020-01-02T00:00:00.000Z';
const T2 = '2020-01-03T00:00:00.000Z';

describe('an upheld dispute', () => {
  it('is upheld when the most recent closing ruling says so', () => {
    expect(disputeIsUpheld([])).toBe(false);
    expect(disputeIsUpheld([{ ruling: 'upheld' }])).toBe(true);
    expect(disputeIsUpheld([{ ruling: 'rejected' }])).toBe(false);
    // Superseded does not close, so it does not decide either.
    expect(disputeIsUpheld([{ ruling: 'upheld' }, { ruling: 'superseded' }])).toBe(true);
    // Overturned on appeal: the outcome that now stands is the later one.
    expect(disputeIsUpheld([{ ruling: 'upheld' }, { ruling: 'rejected' }])).toBe(false);
    expect(disputeIsUpheld([{ ruling: 'rejected' }, { ruling: 'upheld' }])).toBe(true);
  });

  it('is counted by the tally, apart from open ones', () => {
    const profile = tallyAssurance([], {
      disputes: [
        { disputeId: 'd1', openedByRef: 'a', openedByKind: 'human', open: false, upheld: true },
        { disputeId: 'd2', openedByRef: 'b', openedByKind: 'human', open: true },
        { disputeId: 'd3', openedByRef: 'c', openedByKind: 'human', open: false, upheld: false },
      ],
    });
    expect(profile.disputesOpen).toBe(1);
    expect(profile.disputesUpheld).toBe(1);
  });

  it('keeps holding a version after the ruling that closed it', async () => {
    // The flaw, end to end: with `noOpenDisputes` alone, upholding the
    // objection is what lets the version publish.
    const store = new MemoryAssuranceStore();
    store.seedProposal({
      proposalId: 'p1',
      target: { space: 's', type: 'note', id: 'n1' },
      author: { actorRef: 'user:1', kind: 'human', capabilities: [], assuranceCapabilities: [] },
      createdAt: T0,
    });
    const version = store.seedVersion({ proposalId: 'p1', versionId: 'v1', submittedAt: T0 });
    for (const reviewer of ['user:2', 'user:3']) {
      await store.recordAssessment({
        version: version.ref,
        assessorRef: reviewer,
        assessorKind: 'human',
        verdict: 'approve',
        recordedAt: T1,
      });
    }
    const dispute = await store.openDispute({
      version: version.ref,
      openedByRef: 'user:4',
      openedByKind: 'human',
      rationale: 'Quotes the wrong arm of the trial.',
      openedAt: T1,
    });
    await store.ruleDispute({
      disputeId: dispute.disputeId,
      ruling: 'upheld',
      ruledByRef: 'user:5',
      ruledAt: T2,
    });

    const assurance = tallyAssurance(
      (await store.currentAssessments(version.ref)).map((a) => a),
      { authorRef: 'user:1', disputes: await store.disputes(version.ref) },
    );
    const context = makeContext({ assurance });
    const openOnly = policy('open-only', '1')
      .rule({ id: 'base', require: [independentApprovals(2), noOpenDisputes()] })
      .build();
    const both = policy('both', '1')
      .rule({
        id: 'base',
        require: [independentApprovals(2), noOpenDisputes(), noUpheldDisputes()],
      })
      .build();

    expect(openOnly.evaluate(context).allowed).toBe(true);
    const held = both.evaluate(context);
    expect(held.allowed).toBe(false);
    expect(held.unmet.map((o) => o.requirementId)).toEqual(['disputes.noneUpheld']);
    expect((await store.disputes(version.ref))[0]!.rationale).toBe(
      'Quotes the wrong arm of the trial.',
    );
  });

  it('does not change the fingerprint of a context that has none', () => {
    // A profile built before the field existed, and the same facts tallied
    // now, must fingerprint alike — or every stored fingerprint disagrees with
    // a re-evaluation of identical inputs.
    const now = makeContext();
    const { disputesUpheld: _dropped, ...legacy } = now.assurance;
    const before = { ...now, assurance: legacy as unknown as AssuranceProfile };
    expect(fingerprintPolicyContext(now)).toBe(fingerprintPolicyContext(before));
    expect(
      fingerprintPolicyContext(
        makeContext({ assurance: { ...EMPTY_ASSURANCE_PROFILE, disputesUpheld: 1 } }),
      ),
    ).not.toBe(fingerprintPolicyContext(now));
  });
});

describe('a policy definition', () => {
  const build = (count: number, version = '1') =>
    policy('p', version)
      .rule({ id: 'base', require: [independentApprovals(count)] })
      .otherwise({ id: 'fallback', require: [humanApproval()] })
      .build();

  it('fingerprints alike when rebuilt the same', () => {
    expect(build(2).definitionFingerprint).toBe(build(2).definitionFingerprint);
  });

  it('fingerprints differently when edited in place under the same version', () => {
    expect(build(2).definitionFingerprint).not.toBe(build(1).definitionFingerprint);
  });

  it('fingerprints differently under a new version label', () => {
    expect(build(2, '1').definitionFingerprint).not.toBe(
      build(2, '2').definitionFingerprint,
    );
  });

  it('is named by every decision taken under it', () => {
    const p = build(2);
    expect(p.evaluate(makeContext()).policyFingerprint).toBe(p.definitionFingerprint);
  });
});

describe('decisionRecord', () => {
  it('keeps the whole breakdown, so a stored decision can still say why', async () => {
    const p = policy('p', '1')
      .rule({ id: 'base', require: [independentApprovals(2), humanApproval()] })
      .build();
    const decision = p.evaluate(makeContext());
    const ref = { proposalId: 'p1', versionId: 'v1' };
    const input = decisionRecord(decision, { version: ref, mode: 'shadow', evaluatedAt: T0 });

    expect(input).toMatchObject({
      policyId: 'p',
      policyVersion: '1',
      policyFingerprint: p.definitionFingerprint,
      allowed: false,
      inputFingerprint: decision.inputFingerprint,
      mode: 'shadow',
      matchedRuleIds: ['base'],
    });
    expect(input.unmet).toEqual(
      decision.unmet.map((o) => ({
        requirementId: o.requirementId,
        ruleId: 'base',
        detail: o.detail,
      })),
    );
    expect(input.unmet!.length).toBeGreaterThan(0);
  });
});

describe('compareShadowDecision', () => {
  it('says which way a disagreement points', () => {
    expect(compareShadowDecision({ allowed: true }, { allowed: true })).toBe('agree');
    expect(compareShadowDecision({ allowed: false }, { allowed: false })).toBe('agree');
    // Would have held what published: the cost of switching is delay.
    expect(compareShadowDecision({ allowed: false }, { allowed: true })).toBe('stricter');
    // Would have published what was held: the cost is publishing what people
    // refused.
    expect(compareShadowDecision({ allowed: true }, { allowed: false })).toBe(
      'more_permissive',
    );
  });
});

describe('formatVersionRef', () => {
  it('formats ordinary ids exactly as before', () => {
    expect(formatVersionRef({ proposalId: 'p1', versionId: 'v1' })).toBe('p1#v1');
  });

  it('cannot make two different references format alike', () => {
    const a = formatVersionRef({ proposalId: 'a#b', versionId: 'c' });
    const b = formatVersionRef({ proposalId: 'a', versionId: 'b#c' });
    expect(a).not.toBe(b);
    const c = formatVersionRef({ proposalId: 'a\\', versionId: 'b' });
    const d = formatVersionRef({ proposalId: 'a', versionId: '\\b' });
    expect(c).not.toBe(d);
  });
});
