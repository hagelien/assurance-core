/**
 * A worked example on a domain with nothing to do with the one this core was
 * extracted from: an architecture-decision log.
 *
 * Run it with `npx tsx examples/adr-log.ts`. It is deliberately executable —
 * a README example that has never run is a guess.
 */
import {
  policy,
  tallyAssurance,
  snapshotActor,
  assessmentFromActor,
  humanApproval,
  independentApprovals,
  noDisputingAssessments,
  reviewerPoolState,
  describeDecision,
  firstUnmet,
  type ActorContext,
  type PolicyContext,
} from '../src/index.js';

const author: ActorContext = {
  actorRef: 'user:12',
  kind: 'human',
  capabilities: ['propose'],
};
const reviewingAgent: ActorContext = {
  actorRef: 'agent:reviewer-1',
  kind: 'agent',
  capabilities: ['assess'],
  assuranceCapabilities: ['model_tier:high'],
};
const principalEngineer: ActorContext = {
  actorRef: 'user:44',
  kind: 'human',
  capabilities: ['assess'],
};

// Anything superseding an accepted decision needs a human to sign it off, not
// only agents agreeing with each other.
const adrPolicy = policy('adr-review', 'v1')
  .rule({
    id: 'baseline',
    require: [independentApprovals(2), noDisputingAssessments()],
  })
  .rule({
    id: 'supersede-needs-a-human',
    when: { risk: 'high', riskTags: ['supersedes_accepted'] },
    require: [humanApproval()],
  })
  .build();

function contextWith(assessors: ActorContext[]): PolicyContext {
  return {
    space: 'adr',
    targetType: 'decision_record',
    proposalVersionId: 'adr-0007@v2',
    author: snapshotActor(author),
    risk: { level: 'high', tags: ['supersedes_accepted'] },
    assurance: tallyAssurance(
      assessors.map((a) => assessmentFromActor(snapshotActor(a), 'approve')),
      { authorRef: author.actorRef },
    ),
    pool: reviewerPoolState({ poolSize: 5, designTargetQuorum: 2 }),
    flags: [],
  };
}

// Two agents agree. The baseline quorum is met and it still may not publish.
const agentsOnly = adrPolicy.evaluate(
  contextWith([reviewingAgent, { ...reviewingAgent, actorRef: 'agent:reviewer-2' }]),
);
console.log(describeDecision(agentsOnly));
console.log('  blocked by:', firstUnmet(agentsOnly)?.description ?? '(nothing)');

// A principal engineer looks at it. Same quorum, different composition.
const withHuman = adrPolicy.evaluate(
  contextWith([reviewingAgent, principalEngineer]),
);
console.log(describeDecision(withHuman));
