/**
 * The second host, run end to end.
 *
 * `npm run example:host`. Deliberately executable — an example that has never
 * run is a guess — and deliberately printed step by step, because the point is
 * not the final answer but which requirement was unmet at each stage.
 */
import { AdrLog } from './log.js';
import { AdrAssuranceStore, ADR_SPACE } from './store.js';
import { AdrHost } from './host.js';
import { describeDecision, type ActorContext } from '../../src/index.js';

const AUTHOR: ActorContext = { actorRef: 'user:12', kind: 'human', capabilities: ['propose'] };
const AGENT_A: ActorContext = { actorRef: 'agent:reviewer-1', kind: 'agent', capabilities: ['assess'] };
const AGENT_B: ActorContext = { actorRef: 'agent:reviewer-2', kind: 'agent', capabilities: ['assess'] };
const PRINCIPAL: ActorContext = { actorRef: 'user:44', kind: 'human', capabilities: ['assess'] };

const log = new AdrLog();
log.addAdr({ number: 7, title: 'Use a queue', status: 'accepted', context: '', decision: 'A queue.' });
log.addAdr({ number: 12, title: 'Use a log', status: 'draft', context: '', decision: '' });

const change = log.openChange({ adrNumber: 12, openedBy: AUTHOR.actorRef, at: new Date() });
const draft = log.addDraft(change.id, {
  title: 'Use a log instead',
  context: 'The queue lost ordering under partition.',
  decision: 'Adopt an append-only log.',
  supersedes: [7],
  writtenBy: AUTHOR.actorRef,
  writtenAt: new Date(),
});

const store = new AdrAssuranceStore(
  log,
  new Map([
    [AGENT_A.actorRef, ['model_tier:high']],
    [AGENT_B.actorRef, ['model_tier:high']],
  ]),
);
const host = new AdrHost({ log, store, reviewerPoolSize: 4, now: () => new Date() });
const ref = { proposalId: String(change.id), versionId: String(draft.id) };

async function attempt(label: string): Promise<void> {
  const { decision, merged } = await host.tryPublish(ref);
  console.log(`${label}: ${merged ? 'PUBLISHED' : 'held'} — ${describeDecision(decision)}`);
}

async function main(): Promise<void> {
  console.log(`Space '${ADR_SPACE}', proposing to supersede ADR-7 with ADR-12.\n`);

  await attempt('no reviews yet   ');

  const queue = await host.queueFor(AGENT_A);
  console.log(`\nqueue for ${AGENT_A.actorRef}: ${queue.items.length} item(s)`);
  const packet = await host.packetFor(ref);
  console.log(`packet shows: ${Object.keys(packet.proposed).join(', ')}`);
  console.log(`packet hides: every reviewer's verdict and the running tally\n`);

  await host.assess(AGENT_A, ref, 'approve');
  await host.assess(AGENT_B, ref, 'approve');
  await attempt('two agents agree ');

  await host.assess(PRINCIPAL, ref, 'approve');
  await attempt('a human signs off');

  const adr = log.adr(12)!;
  console.log(`\nADR-12 is now revision ${adr.revision}: "${adr.decision}"`);
  console.log(`ADR-7 is now ${log.adr(7)!.status}.`);
}

void main();
