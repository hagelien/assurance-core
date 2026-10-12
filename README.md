# assurance-core

Decide when a proposed change to a body of knowledge has been reviewed enough
to publish - and be able to explain the answer afterwards.

This package does **not** decide whether something is true. It computes how
well-attested a proposal is, applies a policy to that, and produces a decision
record you can re-read a year later and still understand.

```bash
npm install assurance-core
```

## What it is

Given the assessments recorded against a proposed change - who assessed it,
what they concluded, and what the host knows about them - the core answers one
question: may this publish yet?

- **Zero dependencies.** No database driver, no ORM, no HTTP, no UI framework,
  no network. Not even Node built-ins: `src/` is compiled with no ambient Node
  types at all, so it cannot read a file, a clock, or an environment variable.
- **Deterministic.** The same context always yields the same decision. No
  clock, no randomness, no I/O, which is what makes a stored decision record
  auditable rather than merely archived.
- **Explainable.** A held proposal says which requirement is unmet, in a
  sentence a person can read.
- **Domain-independent.** Nothing here knows what your knowledge is *about*.

## Running a review, not just deciding one

A decision is a moment; a review is a sequence of them over days. Three pieces
cover the parts of that sequence which are the same in every domain:

- **`AssuranceStore`** - the persistence *port*. An interface your store
  implements, not a storage layer this package owns. It carries governance
  history: assessments, disputes and their rulings, decisions against a
  version. It deliberately cannot create a proposal, append a version, or
  publish. Those are host acts over content this package cannot read.
- **`runStoreConformance`** - the contract, executable. A TypeScript interface
  states shapes and nothing else; it cannot say that a revision must not
  inherit the previous version's approvals. That clause and the rest of the
  store contract are checked against your adapter, and the suite returns plain
  results so you assert on them in whatever test framework you already use.
  No framework dependency comes with it.
- **`selectReviewQueue`** and **`sealReviewPacket`** - who gets asked to review
  what, and what they are allowed to see. The packet guard refuses to seal a
  reviewer's packet that carries another reviewer's verdict or the running
  tally, so blind review survives the next adapter written by someone who never
  read the query that was careful. Serving from a store directly, use
  **`selectReviewQueueFromStore`**: the eligibility rules apply *after* the
  store's limit, so a reviewer who has judged the oldest page would otherwise
  be served nothing while the backlog behind it is full, and that difference
  only appears against a real backlog.

`MemoryAssuranceStore` implements the port in memory for tests and examples.
It is the same store the conformance suite runs against, so "what the contract
means" and "what the reference does" cannot drift apart.

## What it deliberately leaves to you

Three things, each because centralising them would be wrong rather than hard:

1. **Persistence.** The core describes the shape of your store and never owns a
   database driver. A host may implement the port over Postgres, SQLite, an
   existing application database, or something else.
2. **Publishing.** Writing a change into your knowledge base is the one part
   that does not generalise: what "applied" means differs completely between a
   reference work, a decision log and a rulebook. There is no `publish` here.
3. **Actor resolution and projection.** You authenticate the caller and hand
   down an `ActorContext`; the core never authenticates anybody. How an
   `AssuranceProfile` appears to readers - a numeric level, a badge, a traffic
   light, a sentence - is a product decision. The core takes no position, and
   deliberately has no universal score. "Two agents agreed but no human
   looked" and "one high-tier reviewer approved" are different states, and no
   single integer says both.

## Repository boundary

This repository is the canonical home for the reusable governance work, but the
**`assurance-core` package remains the small dependency-free kernel**.

That distinction matters as the original host continues its migration. A
reusable Postgres implementation, SDK, HTTP layer, or UI package may eventually
belong beside the core in this repository if multiple hosts demonstrate the
need. They should not be folded into the core package simply because they are
related to governance.

In particular:

- do not add Drizzle, Neon, HTTP, React, filesystem access, environment reads,
  authentication or host mutation logic to `assurance-core`;
- extract a storage package only after host-specific legacy decoding and policy
  assumptions have been separated from canonical persistence semantics;
- extract an SDK when a second real consumer needs the client and therefore
  tests which bindings are genuinely generic;
- keep hosted-service and UI layers optional. A host should not need another
  network service online in order to use the core.

A clean import graph is necessary for extraction and not sufficient. If an
adapter interprets old host-specific record shapes or relies on one host's
policy direction to recover corrupt data safely, that compatibility belongs at
the host boundary rather than in a generic database package.

## Two hosts, one of them not the original

`examples/adr-host/` is a complete second host: an architecture-decision log
with its own tables, its own integer keys and its own idea of what a change is,
wired to this package afterwards rather than designed around it. It runs a
review end to end (`npm run example:host`), and its store adapter is put through
`runStoreConformance` in the package's own test suite.

That is the most useful check that this core is domain-independent, and it paid
for itself immediately. Building it found things no amount of naming review
would have:

- The conformance suite was choosing row ids. A real host may allocate its own
  keys, so the contract changed: the harness now returns the ids the host
  assigned. The same proved true of target ids.
- A host that governs one collection cannot demonstrate space scoping. Those
  clauses are reported as **skipped**, not passed. A green run that silently
  covers less is worse than a shorter one that says so.
- A real bug in the example host: `??` where `=== undefined` was meant, so every
  unsubmitted draft came back looking reviewable. Nothing in that host's own
  tests would have caught it because nothing there read the field.

## A worked example

From [`examples/adr-log.ts`](examples/adr-log.ts), an architecture-decision log
chosen because it has nothing in common with the domain this core was extracted
from. Run it with `npm run example`.

```ts
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

const decision = adrPolicy.evaluate(context);
```

Two agents approve it. The quorum of two is satisfied, and it still may not
publish:

```text
adr-review@v1: held — assurance.humanApproval (0 human approval(s))
  blocked by: at least one approval from a human
```

Swap one agent for a principal engineer - same quorum, different composition:

```text
adr-review@v1: allowed
```

That is the whole idea. *How many* approvals is rarely the interesting
question; *whose*, and of what kind, usually is.

## Concepts

| Concept | What it carries |
| --- | --- |
| `ActorContext` | The caller as the host resolved it: identity, kind, capabilities. |
| `Assessment` | One reviewer's verdict on one proposal version: `approve`, `dispute`, `abstain`. |
| `AssuranceProfile` | What a version has actually accumulated: counts, composition, capabilities. Built by `tallyAssurance`. |
| `RiskProfile` | The host's classification: a level plus free-form tags. The core never computes this. |
| `Requirement` | A composable, self-explaining predicate: `independentApprovals(2)`, `humanApproval()`, ... |
| `PolicySet` | Versioned rules. Built with `policy(id, version)`, evaluated against a `PolicyContext`. Carries a `definitionFingerprint` of what it requires. |
| `PolicyDecision` | The auditable output: allowed or held, which rule, which requirements, and fingerprints of the inputs and of the policy definition. |
| `StoredDecision` | A decision as the store keeps it, breakdown included. Build the input with `decisionRecord(decision, ...)`. |

### Two distinctions worth understanding early

**`capabilities` vs `assuranceCapabilities`.** The first gate *actions*: what
this actor is allowed to do. The second gate publication requirements and must
be **server-owned**. That is a security boundary, not a naming convention: a
value the caller could have chosen must never satisfy an assurance requirement.
A model string an agent reports about itself is audit metadata; the tier your
server recorded when the assessment was written may be an assurance capability.

**Open vs upheld disputes.** Closing an objection and finding it correct are
different facts. `noOpenDisputes()` holds a version while an objection is being
heard and stops the moment any ruling closes it, including the ruling that it
was right. `noUpheldDisputes()` is what keeps holding after that. A policy that
honours formal disputes almost always wants both.

**Design target vs effective quorum.** A policy states the quorum it wants. A
small reviewer pool may not be able to reach it. `ReviewerPoolState` carries
both, plus `degraded`, so a decision made under a reduced quorum records that
fact rather than silently looking like a decision made under the full one.

## Versioning and decision records

Every decision records the policy id **and version** it was made under. A later
policy change therefore cannot retroactively imply that older content was
published under the new rule. Requirement ids and rule ids are stable strings
that end up in persisted records: renaming one is a breaking change, and rule
ids are given explicitly rather than derived from position so reordering a file
cannot silently re-point historical records at a different rule.

A version label is a promise not to edit a policy in place, and a promise is
all it is. So every decision also carries the policy's `definitionFingerprint`:
two decisions naming `v1` with different fingerprints were made under two
different rules. A stored decision keeps its breakdown too (the rules that
applied and every unmet requirement), so it can still say *why* it held a
version after the inputs it was taken over are gone.

## Development

```bash
npm install
npm test
npm run typecheck
npm run example
npm run example:host
npm run build
```

`tests/purity.test.ts` enforces the claims at the top of this file: no
non-relative import anywhere in `src/`, no declared runtime dependencies, no
clock or randomness, and no host-domain vocabulary in comments as well as code.
That last part is deliberate. When this core was extracted, its code was already
clean while its doc comments named the original host and pointed at files that
do not exist in this repository. A comment describing a codebase the reader
cannot open is worse than no comment.

## Releasing

Publishing is automated by `.github/workflows/publish.yml` and supports several
ways to cut the same version:

- push a `v*` tag such as `v0.4.0`;
- push a `release/v*` branch such as `release/v0.4.0`;
- publish a GitHub release;
- use `workflow_dispatch` to retry a failed publish.

For tag, branch and release events, the workflow refuses to publish when the ref
version does not match `package.json`. `prepublishOnly` runs typecheck, tests and
build before upload, so the gate also protects a publish started outside CI.

The workflow publishes with `--provenance`, attaching an attestation that links
the package artifact to the workflow and commit that built it. Repository npm
authentication is supplied through `NPM_TOKEN`; if that credential is missing or
invalid, the publish fails loudly.

The `release/v0.3.0` and `v0.4.0` releases went out through this workflow, so
release automation is operational rather than merely configured.

## Status

`0.5.0`, and honest about it. `0.2.0` added the store port, conformance suite,
review queue and review packet. `0.3.0` widened one thing the first real adapter
could not express: a dispute ruling may be `superseded`, meaning a replacement
dispute now governs, and it is the one ruling that does **not** close. Folding
it into `withdrawn` made a host report "withdrawn but open", which loses the
meaning of the record.

That is the intended way for this interface to grow: a word earns a place when
a real store loses meaning without it, not when one might.

`0.4.0` added `selectReviewQueueFromStore` and its window ceiling,
`MAX_CANDIDATE_WINDOW`. It is the release where the queue's paging was made
to hold under a real backlog, and where two clauses the contract had been
assuming were written down and checked.

The queue reads a window of candidates and then applies eligibility. Both
halves of that were wrong in ways only a backlog reveals: a full page was taken
for a full backlog, so the queue stopped while work remained behind it; the
window did not grow until the exclusions had been paid for; and a tie at the
window boundary could settle a reserve that a later row would have changed. The
window now grows to a ceiling (`MAX_CANDIDATE_WINDOW`), reads one row past
itself to tell a full page from a finished one, and reports a bad ceiling rather
than spinning on it. A cache was removed outright rather than repaired: its key
was a projection the contract allows to change underneath it, which makes a
correct-looking hit wrong.

Two contract clauses are now explicit, and this is the part to read before
upgrading an existing adapter. **Every timestamp the port returns must be an
ISO-8601 instant in UTC with milliseconds** — `2020-01-01T00:00:00.000Z`. The
offset and the fractional width are both part of it, because
`2020-01-01T01:00:00+01:00` is the same instant as `00:00:00Z` and sorts after
it, so a queue promising oldest-first quietly stops delivering it. That covers
the rows a write hands back as well as the ones a read returns. **A submitted
version is never older than its own proposal**, which is what lets the queue
stop before reading a whole backlog. The conformance suite checks both, so an
adapter that passed against `0.3.0` may report failures against `0.4.0`. Those
failures are the point: the behaviour they name was always required, and was
previously enforced only by whichever host happened to get it right.

`0.5.0` fixes a flaw and keeps what decisions and disputes used to lose.

- **An upheld dispute stopped holding the version it objected to.** A ruling of
  `upheld` closes a dispute, so `noOpenDisputes()` was satisfied by exactly the
  outcome that says the version is wrong. Disputes now report `upheld`, the
  tally counts `disputesUpheld`, and `noUpheldDisputes()` holds on it. The
  original host had worked around this in its own code. That is the same signal
  that added `superseded`: a real store lost meaning without the word.
- **Stored records keep their reasons.** A dispute keeps its `rationale`. A
  decision keeps `matchedRuleIds`, its `unmet` requirements and the policy's
  `definitionFingerprint`. `decisionRecord()` builds the input from a
  `PolicyDecision`, so the breakdown is not left out by hand.
  `latestDecision(ref, { mode: 'authoritative' })` finds the decision that bound
  a version even when a shadow evaluation was recorded after it.
- **Shadow mode can be read.** `compareShadowDecision()` says whether a shadow
  policy agrees with what happened, would have been stricter, or would have
  been more permissive. Only the last of these should stop a policy from being
  made binding.
- **The queue can exclude a reviewer with a stake in the outcome**, through
  `conflictedRefs` on a candidate. A self-review grant does not lift it.
- **Review packets name the whole version** (`proposalVersion`). They also no
  longer carry one host's field names in their allow-list: a host whose content
  trips the peer-signal guard passes its own `allowKeys`.

Upgrading an adapter to 0.5 means:

- **Disputes:** returning `upheld` and `rationale` on every dispute.
- **Decisions:** storing and returning the decision breakdown, and honouring
  the `mode` narrowing on `latestDecision`.
- **Refusals:** refusing an assessment or a dispute on a version the store
  does not hold, and a ruling on a dispute it does not hold.
- **Listing:** treating an omitted `limit` on `listOpenProposals` as "all".
- **Profiles:** a host that assembles an `AssuranceProfile` by hand rather than
  through `tallyAssurance` must add `disputesUpheld`. A zero is left out of the
  input fingerprint, so existing fingerprints are unchanged.

The conformance suite checks all of these. A host that relied on the packet's
built-in allow-list now passes those keys itself.

Two hosts use it: the reference work it was extracted from, and the ADR log in
`examples/`. The second is deliberately small, so "it fits two domains" is a
real claim about a modest range rather than a large one. Expect the surface to
move before `1.0`.

## Licence

MIT
