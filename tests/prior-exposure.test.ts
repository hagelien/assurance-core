/**
 * Prior AI exposure: whether a reviewer formed their judgment before or after
 * seeing AI output about the proposal.
 *
 * "A human independently checked this" and "a human agreed with what an agent
 * said" are different kinds of evidence. These tests cover the four places the
 * distinction lives: the assessment, the tally, the requirement that reads it,
 * and the store, which must not let an exposed verdict be re-recorded as an
 * independent one.
 */
import { describe, expect, it } from 'vitest';
import {
  assessmentFromActor,
  priorExposureOf,
  raisePriorExposure,
  tallyAssurance,
  EMPTY_ASSURANCE_PROFILE,
  type Assessment,
  type PriorExposure,
} from '../src/assurance.js';
import { describeDecision, fingerprintPolicyContext } from '../src/decisions.js';
import { policy } from '../src/policy.js';
import {
  humanApproval,
  independentHumanApproval,
  REQUIREMENT_IDS,
} from '../src/requirements.js';
import { riskProfile } from '../src/risk.js';
import { memoryStore } from '../src/store-memory.js';
import { toAssessment } from '../src/store.js';
import { makeContext } from './support/policy-context.js';

function human(
  ref: string,
  priorExposure?: PriorExposure,
  overrides: Partial<Assessment> = {},
): Assessment {
  return {
    assessorRef: ref,
    assessorKind: 'human',
    verdict: 'approve',
    implicit: false,
    ...(priorExposure !== undefined ? { priorExposure } : {}),
    ...overrides,
  };
}

describe('priorExposureOf', () => {
  it('reads an absent exposure as unknown', () => {
    expect(priorExposureOf({})).toBe('unknown');
    expect(priorExposureOf({ priorExposure: 'none' })).toBe('none');
    expect(priorExposureOf({ priorExposure: 'ai_output' })).toBe('ai_output');
  });
});

describe('raisePriorExposure', () => {
  it.each<[PriorExposure | undefined, PriorExposure | undefined, PriorExposure | undefined]>([
    // Never falls to `none` once anything else was on record.
    ['none', 'ai_output', 'ai_output'],
    ['none', 'unknown', 'unknown'],
    ['none', undefined, 'unknown'],
    ['unknown', 'ai_output', 'ai_output'],
    [undefined, 'ai_output', 'ai_output'],
    // Rising, or holding, keeps what was recorded.
    ['ai_output', 'none', 'ai_output'],
    ['unknown', 'none', 'unknown'],
    ['none', 'none', 'none'],
    // A host that never records exposure stores exactly what it did before.
    [undefined, undefined, undefined],
    [undefined, 'none', undefined],
  ])('recorded %s after %s stores %s', (recorded, earlier, expected) => {
    expect(raisePriorExposure(recorded, earlier)).toBe(expected);
  });
});

describe('assessmentFromActor', () => {
  const actor = {
    actorRef: 'user:2',
    kind: 'human' as const,
    capabilities: [],
    assuranceCapabilities: [],
  };

  it('carries the exposure the host recorded', () => {
    expect(
      assessmentFromActor(actor, 'approve', { priorExposure: 'none' }).priorExposure,
    ).toBe('none');
  });

  it('carries no exposure key when the host recorded none', () => {
    expect('priorExposure' in assessmentFromActor(actor, 'approve')).toBe(false);
  });
});

describe('tallyAssurance and prior exposure', () => {
  it('splits human approvals by exposure, and the three counts sum to them', () => {
    const profile = tallyAssurance([
      human('user:1', 'none'),
      human('user:2', 'ai_output'),
      human('user:3', 'unknown'),
      human('user:4'),
    ]);
    expect(profile.humanApprovals).toBe(4);
    expect(profile.humanApprovalsWithoutAiExposure).toBe(1);
    expect(profile.humanApprovalsAfterAiExposure).toBe(1);
    // Explicit `unknown` and a missing value are the same fact.
    expect(profile.humanApprovalsWithUnknownExposure).toBe(2);
  });

  it('counts only human approvals', () => {
    const profile = tallyAssurance([
      // An agent "without prior AI exposure" is not what the count is about.
      { ...human('agent:1', 'none'), assessorKind: 'agent' },
      { ...human('svc:1', 'none'), assessorKind: 'service' },
      human('user:2', 'none', { verdict: 'dispute' }),
      human('user:3', 'none', { verdict: 'abstain' }),
      human('user:4', 'none', { implicit: true }),
    ]);
    expect(profile.humanApprovalsWithoutAiExposure).toBe(0);
    expect(profile.humanApprovalsAfterAiExposure).toBe(0);
    expect(profile.humanApprovalsWithUnknownExposure).toBe(0);
  });

  it('reads the exposure of a reviewer’s standing assessment', () => {
    const profile = tallyAssurance([
      human('user:1', 'none', { verdict: 'abstain' }),
      human('user:1', 'ai_output'),
    ]);
    expect(profile.humanApprovals).toBe(1);
    expect(profile.humanApprovalsAfterAiExposure).toBe(1);
    expect(profile.humanApprovalsWithoutAiExposure).toBe(0);
  });

  it('reports zero for every count on an empty tally', () => {
    expect(EMPTY_ASSURANCE_PROFILE.humanApprovalsWithoutAiExposure).toBe(0);
    expect(EMPTY_ASSURANCE_PROFILE.humanApprovalsAfterAiExposure).toBe(0);
    expect(EMPTY_ASSURANCE_PROFILE.humanApprovalsWithUnknownExposure).toBe(0);
  });
});

describe('independentHumanApproval', () => {
  const requirement = independentHumanApproval();
  const evaluate = (assessments: readonly Assessment[]) =>
    requirement.evaluate(makeContext({ assurance: tallyAssurance(assessments) }));

  it('exposes a stable id and describes itself', () => {
    expect(requirement.id).toBe('assurance.independentHumanApproval');
    expect(requirement.id).toBe(REQUIREMENT_IDS.independentHumanApproval);
    expect(requirement.params).toEqual({});
    expect(requirement.describe()).toBe(
      'at least one approval from a human who judged before seeing AI output',
    );
  });

  it('is met by a human who approved before seeing AI output', () => {
    const outcome = evaluate([human('user:1', 'none')]);
    expect(outcome.met).toBe(true);
    expect(outcome.detail).toBe('1 human approval(s) made without prior AI exposure');
  });

  it('is not met by a human who approved after viewing AI output, and says so', () => {
    const outcome = evaluate([human('user:1', 'ai_output')]);
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toBe(
      '0 human approval(s) made without prior AI exposure; 1 made after viewing AI output',
    );
    // The weaker requirement is still met by the same approval: the two say
    // different things, which is the point of having both.
    expect(
      humanApproval().evaluate(
        makeContext({ assurance: tallyAssurance([human('user:1', 'ai_output')]) }),
      ).met,
    ).toBe(true);
  });

  it('counts unknown exposure as exposed, but reports it apart from AI output', () => {
    const outcome = evaluate([
      human('user:1', 'ai_output'),
      human('user:2', 'unknown'),
      human('user:3'),
    ]);
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toBe(
      '0 human approval(s) made without prior AI exposure; ' +
        '1 made after viewing AI output; ' +
        '2 with unknown prior exposure, counted as exposed',
    );
  });

  it('is not met by agents however independently they judged', () => {
    const outcome = evaluate([
      { ...human('agent:1', 'none'), assessorKind: 'agent' },
    ]);
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toBe('0 human approval(s) made without prior AI exposure');
  });

  it('explains a profile built by hand before the exposure counts existed', () => {
    // Every human approval it carries is one nobody recorded exposure for.
    const handBuilt = { ...EMPTY_ASSURANCE_PROFILE, humanApprovals: 2 };
    delete (handBuilt as Record<string, unknown>).humanApprovalsWithoutAiExposure;
    delete (handBuilt as Record<string, unknown>).humanApprovalsAfterAiExposure;
    delete (handBuilt as Record<string, unknown>).humanApprovalsWithUnknownExposure;
    const outcome = requirement.evaluate(makeContext({ assurance: handBuilt }));
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toBe(
      '0 human approval(s) made without prior AI exposure; ' +
        '2 with unknown prior exposure, counted as exposed',
    );
  });

  it('says why a held proposal is held', () => {
    const set = policy('exposure-test', 'v1')
      .rule({ id: 'high-risk', when: { risk: 'high' }, require: [independentHumanApproval()] })
      .otherwise({ id: 'baseline', require: [humanApproval()] })
      .build();
    const decision = set.evaluate(
      makeContext({
        risk: riskProfile('high'),
        assurance: tallyAssurance([human('user:1', 'ai_output')]),
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(describeDecision(decision)).toBe(
      'exposure-test@v1: held — assurance.independentHumanApproval ' +
        '(0 human approval(s) made without prior AI exposure; 1 made after viewing AI output)',
    );
  });
});

describe('the input fingerprint and prior exposure', () => {
  // Pinned values, computed from the sources before exposure existed. A host
  // that never records exposure must see every stored fingerprint agree with a
  // re-evaluation of the same facts after upgrading.
  it('is unchanged for a tally that carries no exposure', () => {
    const assurance = tallyAssurance([
      human('user:2'),
      { ...human('agent:3'), assessorKind: 'agent' },
    ]);
    expect(fingerprintPolicyContext(makeContext({ assurance }))).toBe(
      'f4f52766caaf5f72',
    );
  });

  it('is unchanged for a profile built by spreading the empty profile', () => {
    expect(
      fingerprintPolicyContext(makeContext({ assurance: { humanApprovals: 1 } })),
    ).toBe('763e4cbb6f38c777');
  });

  it('changes when the exposure of an approval changes', () => {
    const of = (exposure?: PriorExposure) =>
      fingerprintPolicyContext(
        makeContext({ assurance: tallyAssurance([human('user:2', exposure)]) }),
      );
    expect(new Set([of('none'), of('ai_output'), of('unknown')]).size).toBe(3);
    // Explicit `unknown` and a missing value are the same fact.
    expect(of('unknown')).toBe(of(undefined));
  });
});

describe('the reference store and prior exposure', () => {
  async function world() {
    const store = memoryStore();
    store.seedProposal({
      proposalId: 'p1',
      target: { space: 's', type: 'note', id: 'n1' },
      author: { actorRef: 'user:1', kind: 'human', capabilities: [], assuranceCapabilities: [] },
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const v1 = store.seedVersion({ proposalId: 'p1', versionId: 'v1' }).ref;
    const v2 = store.seedVersion({ proposalId: 'p1', versionId: 'v2' }).ref;
    return { store, v1, v2 };
  }
  const at = '2020-01-02T00:00:00.000Z';

  it('stores the exposure it was given, and toAssessment carries it', async () => {
    const { store, v1 } = await world();
    const stored = await store.recordAssessment({
      version: v1,
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'approve',
      priorExposure: 'none',
      recordedAt: at,
    });
    expect(stored.priorExposure).toBe('none');
    expect(toAssessment(stored).priorExposure).toBe('none');
  });

  it('stores no exposure key when none was given', async () => {
    const { store, v1 } = await world();
    const stored = await store.recordAssessment({
      version: v1,
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'approve',
      recordedAt: at,
    });
    expect('priorExposure' in stored).toBe(false);
    expect('priorExposure' in toAssessment(stored)).toBe(false);
  });

  it('will not let a reviewer launder an exposed verdict by recording again', async () => {
    const { store, v1 } = await world();
    const first = await store.recordAssessment({
      version: v1,
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'abstain',
      priorExposure: 'ai_output',
      recordedAt: at,
    });
    await store.recordAssessment({
      version: v1,
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'approve',
      priorExposure: 'none',
      supersedesAssessmentId: first.assessmentId,
      recordedAt: at,
    });
    const profile = tallyAssurance((await store.currentAssessments(v1)).map(toAssessment));
    expect(profile.humanApprovals).toBe(1);
    expect(profile.humanApprovalsWithoutAiExposure).toBe(0);
    expect(profile.humanApprovalsAfterAiExposure).toBe(1);
    expect(
      independentHumanApproval().evaluate(makeContext({ assurance: profile })).met,
    ).toBe(false);
  });

  it('scopes the floor to one assessor on one version', async () => {
    const { store, v1, v2 } = await world();
    await store.recordAssessment({
      version: v1,
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'approve',
      priorExposure: 'ai_output',
      recordedAt: at,
    });
    // A new version is a new judgment, and another reviewer is another person.
    const onNewVersion = await store.recordAssessment({
      version: v2,
      assessorRef: 'user:2',
      assessorKind: 'human',
      verdict: 'approve',
      priorExposure: 'none',
      recordedAt: at,
    });
    const someoneElse = await store.recordAssessment({
      version: v1,
      assessorRef: 'user:3',
      assessorKind: 'human',
      verdict: 'approve',
      priorExposure: 'none',
      recordedAt: at,
    });
    expect(onNewVersion.priorExposure).toBe('none');
    expect(someoneElse.priorExposure).toBe('none');
  });
});
