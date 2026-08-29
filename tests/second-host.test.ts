/**
 * The second-host gate.
 *
 * A core is domain-independent when a second domain can use it, and no amount
 * of careful naming establishes that. The host under test here — an
 * architecture-decision log — was written with its own tables, its own integer
 * keys and its own idea of what a change is, and the governance was wired
 * around it afterwards. Its store adapter is a separate implementation from
 * the package's reference one on purpose: running the conformance suite
 * against `MemoryAssuranceStore` would test the reference against itself.
 *
 * Three things are established:
 *
 *   1. A foreign store satisfies the port's contract.
 *   2. A full review runs end to end through the package — queue, packet,
 *      assessments, policy, decision record, publication.
 *   3. The parts that stayed with the host are the parts that had to.
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryAssuranceStore,
  conformanceFailures,
  conformanceSkipped,
  runStoreConformance,
  type ActorContext,
  type ConformanceHarness,
  type ProposalVersionRef,
} from '../src/index.js';
import { AdrLog } from '../examples/adr-host/log.js';
import {
  ADR_SPACE,
  ADR_TARGET_TYPE,
  AdrAssuranceStore,
} from '../examples/adr-host/store.js';
import { ADR_POLICY, AdrHost } from '../examples/adr-host/host.js';

const AUTHOR: ActorContext = {
  actorRef: 'user:12',
  kind: 'human',
  capabilities: ['propose'],
};
const AGENT_A: ActorContext = {
  actorRef: 'agent:reviewer-1',
  kind: 'agent',
  capabilities: ['assess'],
  assuranceCapabilities: ['model_tier:high'],
};
const AGENT_B: ActorContext = {
  actorRef: 'agent:reviewer-2',
  kind: 'agent',
  capabilities: ['assess'],
  assuranceCapabilities: ['model_tier:high'],
};
const PRINCIPAL: ActorContext = {
  actorRef: 'user:44',
  kind: 'human',
  capabilities: ['assess'],
};

/** A clock that advances a minute per call, so ordering is deterministic. */
function tickingClock(): () => Date {
  let ms = Date.UTC(2024, 0, 1);
  return () => {
    ms += 60_000;
    return new Date(ms);
  };
}

interface World {
  log: AdrLog;
  store: AdrAssuranceStore;
  host: AdrHost;
  ref: ProposalVersionRef;
}

/**
 * One accepted ADR, and a change request superseding it.
 *
 * Superseding is the high-risk case, which is what makes the host's second
 * policy rule reachable — a fixture that only exercised the low-risk path
 * would leave the rule this host actually wanted governance for untested.
 */
function world(options: { supersedes?: number[]; poolSize?: number } = {}): World {
  const log = new AdrLog();
  const now = tickingClock();
  log.addAdr({
    number: 7,
    title: 'Use a queue',
    status: 'accepted',
    context: 'c',
    decision: 'd',
  });
  log.addAdr({
    number: 12,
    title: 'Use a log instead',
    status: 'draft',
    context: 'c',
    decision: 'd',
  });
  const change = log.openChange({ adrNumber: 12, openedBy: AUTHOR.actorRef, at: now() });
  const draft = log.addDraft(change.id, {
    title: 'Use a log instead',
    context: 'The queue lost ordering under partition.',
    decision: 'Adopt an append-only log.',
    supersedes: options.supersedes ?? [7],
    writtenBy: AUTHOR.actorRef,
    writtenAt: now(),
  });
  const store = new AdrAssuranceStore(
    log,
    new Map([
      [AGENT_A.actorRef, AGENT_A.assuranceCapabilities ?? []],
      [AGENT_B.actorRef, AGENT_B.assuranceCapabilities ?? []],
    ]),
  );
  const host = new AdrHost({
    log,
    store,
    reviewerPoolSize: options.poolSize ?? 4,
    now,
  });
  return {
    log,
    store,
    host,
    ref: { proposalId: String(change.id), versionId: String(draft.id) },
  };
}

describe('a foreign store satisfies the port', () => {
  /**
   * The harness seeds through the host's own tables and hands back the ids the
   * host assigned.
   *
   * That direction is the finding this second host produced. The suite
   * originally chose the ids — `p1`, `v1` — and this adapter could not accept
   * them: a change request's id comes from the log's own counter, and no store
   * worth having lets a caller name the key of a row it is about to create.
   * Every check failed on a lookup by an id the host had never issued, and the
   * cheap fix would have been to filter those failures out of the assertion,
   * which is how a conformance suite becomes decoration. The contract changed
   * instead.
   */
  function makeHarness(): ConformanceHarness {
    const log = new AdrLog();
    const store = new AdrAssuranceStore(log);
    return {
      store,
      // The host governs one collection of one kind, so it declares no second
      // space or type. The suite reports the two clauses that leaves
      // unverified as skipped rather than passing them, and the assertion
      // below names them — a skip list that grows unnoticed is how a
      // conformance run stops meaning anything.
      space: ADR_SPACE,
      targetType: ADR_TARGET_TYPE,
      seed: {
        async proposal(input) {
          const adrNumber = Number(input.target.id.replace(/\D/g, '') || '1');
          if (!log.adr(adrNumber)) {
            log.addAdr({
              number: adrNumber,
              title: 't',
              status: 'accepted',
              context: 'c',
              decision: 'd',
            });
          }
          const change = log.openChange({
            adrNumber,
            openedBy: input.author.actorRef,
            at: new Date(input.createdAt),
          });
          // The host's own way of closing one: it has no `setState`, because
          // the port offers none.
          if (input.open === false) change.state = 'withdrawn';
          return {
            proposalId: String(change.id),
            // The host keys targets by ADR number, so the id it was handed is
            // not the id it used. Reporting the real one is the adapter's job.
            target: {
              space: ADR_SPACE,
              type: ADR_TARGET_TYPE,
              id: String(adrNumber),
            },
          };
        },
        async version(input) {
          const draft = log.addDraft(Number(input.proposalId), {
            title: 't',
            context: 'c',
            decision: 'd',
            // This host derives risk from the draft, so a high-risk version is
            // seeded by giving it something to supersede.
            supersedes: input.risk?.level === 'high' ? [1] : [],
            writtenBy: 'user:1',
            writtenAt: new Date('2020-01-01T00:00:00.000Z'),
            submittedAt:
              input.submittedAt === undefined
                ? new Date('2020-01-01T00:00:00.000Z')
                : input.submittedAt === null
                  ? null
                  : new Date(input.submittedAt),
          });
          return {
            ref: { proposalId: input.proposalId, versionId: String(draft.id) },
          };
        },
        async evidence(ref, state) {
          store.declareEvidence(ref, state);
        },
      },
    };
  }

  it('passes every conformance check, with nothing filtered out', async () => {
    const results = await runStoreConformance(makeHarness);
    expect(conformanceFailures(results)).toEqual([]);
    // Non-vacuity: an empty suite would also report no failures.
    expect(results.length).toBeGreaterThan(15);
  });

  it('leaves exactly the two clauses its shape cannot express', async () => {
    // Pinned, so a future skip has to be added deliberately rather than
    // arriving as a quietly shorter run.
    const skipped = conformanceSkipped(await runStoreConformance(makeHarness));
    expect(skipped.map((line) => line.split(' — ')[0])).toEqual([
      'listOpenProposals filters by target type',
      'a proposal in another space is not listed',
    ]);
  });

  it('is a different implementation from the package reference', async () => {
    // Otherwise the suite would be testing the reference store against itself,
    // and would establish nothing about a store it did not design.
    const { store } = makeHarness();
    expect(store).toBeInstanceOf(AdrAssuranceStore);
    expect(store).not.toBeInstanceOf(MemoryAssuranceStore);
  });
});

describe('a full review runs end to end', () => {
  it('holds until the policy is satisfied, then publishes', async () => {
    const { host, log, store, ref } = world();

    // Nothing has been reviewed: held, and the reason names a requirement.
    const first = await host.tryPublish(ref);
    expect(first.merged).toBe(false);
    expect(first.decision.allowed).toBe(false);
    expect(first.decision.unmet.length).toBeGreaterThan(0);

    // Two agents approve. Enough for the baseline rule, not for a change that
    // supersedes an accepted record — the rule this host wanted governance for.
    await host.assess(AGENT_A, ref, 'approve');
    await host.assess(AGENT_B, ref, 'approve');
    const second = await host.tryPublish(ref);
    expect(second.merged).toBe(false);
    expect(second.decision.unmet.map((u) => u.requirementId)).toContain(
      'assurance.humanApproval',
    );

    // A human signs it off.
    await host.assess(PRINCIPAL, ref, 'approve');
    const third = await host.tryPublish(ref);
    expect(third.decision.allowed).toBe(true);
    expect(third.merged).toBe(true);

    // The host act: the ADR moved, and what it replaced was retired.
    expect(log.adr(12)!.decision).toBe('Adopt an append-only log.');
    expect(log.adr(12)!.revision).toBe(2);
    expect(log.adr(7)!.status).toBe('superseded');
    expect(log.change(Number(ref.proposalId))!.state).toBe('merged');

    // Three decisions on the record, including the two that held it. A hold
    // that leaves no trace of why is the state this arrangement exists to
    // avoid.
    const latest = await store.latestDecision(ref);
    expect(latest!.allowed).toBe(true);
    expect(latest!.policyId).toBe(ADR_POLICY.id);
    expect(latest!.inputFingerprint).toMatch(/\S/);
  });

  it('does not need a human sign-off for a change that supersedes nothing', async () => {
    // The low-risk path: the second rule does not match, so two agents are
    // enough. Asserted so that "held" above is a property of the rule rather
    // than of the fixture always being high-risk.
    const { host, ref } = world({ supersedes: [] });
    await host.assess(AGENT_A, ref, 'approve');
    await host.assess(AGENT_B, ref, 'approve');
    expect((await host.tryPublish(ref)).merged).toBe(true);
  });

  it('holds while an objection stands, and publishes once it is settled', async () => {
    const { host, store, ref } = world({ supersedes: [] });
    await host.assess(AGENT_A, ref, 'approve');
    await host.assess(AGENT_B, ref, 'approve');
    const dispute = await store.openDispute({
      version: ref,
      openedByRef: PRINCIPAL.actorRef,
      openedByKind: 'human',
      openedAt: '2024-01-01T00:00:00.000Z',
    });
    expect((await host.tryPublish(ref)).merged).toBe(false);

    await store.ruleDispute({
      disputeId: dispute.disputeId,
      ruling: 'rejected',
      ruledByRef: PRINCIPAL.actorRef,
      ruledAt: '2024-01-02T00:00:00.000Z',
    });
    expect((await host.tryPublish(ref)).merged).toBe(true);
  });

  it('a reviewer who changes their mind counts once, with the later verdict', async () => {
    const { host, ref } = world({ supersedes: [] });
    await host.assess(AGENT_A, ref, 'dispute');
    await host.assess(AGENT_B, ref, 'approve');
    expect((await host.tryPublish(ref)).merged).toBe(false);

    await host.assess(AGENT_A, ref, 'approve');
    const context = await host.contextFor(ref);
    expect(context.assurance.explicitApprovals).toBe(2);
    expect(context.assurance.disputingAssessors).toBe(0);
    expect((await host.tryPublish(ref)).merged).toBe(true);
  });
});

describe('an actor cannot assert its own capabilities', () => {
  it('records the host’s record of the reviewer, not the reviewer’s claim', async () => {
    // The claim is the attack: an agent that could state its own tier would
    // clear a capability gate by naming one, and the claim would be frozen
    // into the snapshot and keep clearing it afterwards.
    const { host, store, ref } = world({ supersedes: [] });
    const liar: ActorContext = {
      actorRef: 'agent:unknown',
      kind: 'agent',
      capabilities: ['assess'],
      assuranceCapabilities: ['model_tier:flagship'],
    };
    await host.assess(liar, ref, 'approve');
    const [recorded] = await store.currentAssessments(ref);
    expect(recorded!.assuranceCapabilities).toBeUndefined();

    // And a reviewer the host does know keeps what the host knows.
    await host.assess(AGENT_A, ref, 'approve');
    const stored = await store.currentAssessments(ref);
    const known = stored.find((a) => a.assessorRef === AGENT_A.actorRef);
    expect(known!.assuranceCapabilities).toEqual(['model_tier:high']);
  });
});

describe('the queue applies the rules the host did not have to write', () => {
  it('does not offer a reviewer their own change', async () => {
    const { host, ref } = world();
    const mine = await host.queueFor(AUTHOR);
    expect(mine.items).toEqual([]);
    expect(mine.excluded[0]!.reason).toBe('authored_by_caller');

    const theirs = await host.queueFor(AGENT_A);
    expect(theirs.items.map((i) => i.version.versionId)).toEqual([ref.versionId]);
  });

  it('stops offering a change once the reviewer has judged it', async () => {
    const { host, ref } = world();
    expect((await host.queueFor(AGENT_A)).items).toHaveLength(1);
    await host.assess(AGENT_A, ref, 'approve');
    const after = await host.queueFor(AGENT_A);
    expect(after.items).toEqual([]);
    expect(after.excluded[0]!.reason).toBe('already_judged');
    // And the other reviewer is unaffected.
    expect((await host.queueFor(AGENT_B)).items).toHaveLength(1);
  });

  it('honours the host’s own visibility rule', async () => {
    // The one filter the core cannot supply. Here: a change against a record
    // that no longer exists.
    const { host, log } = world();
    const hidden = log.openChange({
      adrNumber: 999,
      openedBy: AUTHOR.actorRef,
      at: new Date('2024-01-01T00:00:00.000Z'),
    });
    log.addDraft(hidden.id, {
      title: 't',
      context: 'c',
      decision: 'd',
      supersedes: [],
      writtenBy: AUTHOR.actorRef,
      writtenAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    const queue = await host.queueFor(AGENT_A);
    expect(queue.items.map((i) => i.target.id)).toEqual(['12']);
    expect(
      queue.excluded.filter((e) => e.reason === 'not_visible'),
    ).toHaveLength(1);
  });
});

describe('the review packet', () => {
  it('shows the change and the baseline, and no peer signal', async () => {
    const { host, ref } = world();
    const packet = await host.packetFor(ref);
    expect(packet.proposed.decision).toBe('Adopt an append-only log.');
    expect(packet.current.title).toBe('Use a log instead');
    expect(packet.targetVersion).toBe('1');

    // Nothing in the packet names a verdict, a count or a tally, at any depth.
    const flat = JSON.stringify(packet).toLowerCase();
    for (const term of ['verdict', 'approval', 'quorum', 'consensus']) {
      expect(flat, `packet mentions ${term}`).not.toContain(term);
    }
  });

  it('still shows nothing after reviewers have voted', async () => {
    // The property that matters: the packet must not start carrying the tally
    // once there is one to carry.
    const { host, ref } = world();
    await host.assess(AGENT_A, ref, 'approve');
    await host.assess(AGENT_B, ref, 'dispute');
    const flat = JSON.stringify(await host.packetFor(ref)).toLowerCase();
    for (const term of ['verdict', 'approval', 'dispute', 'agent:reviewer']) {
      expect(flat, `packet leaks ${term}`).not.toContain(term);
    }
  });
});
