# assurance-core

Decide when a proposed change to a body of knowledge has been reviewed enough
to publish — and be able to explain the answer afterwards.

This package does **not** decide whether something is true. It computes how
well-attested a proposal is, applies a policy to that, and produces a decision
record you can re-read a year later and still understand.

```
npm install assurance-core
```

## What it is

Given the assessments recorded against a proposed change — who assessed it,
what they concluded, and what the host knows about them — the core answers one
question: may this publish yet?

- **Zero dependencies.** No database driver, no ORM, no HTTP, no UI framework,
  no network. Not even Node built-ins: `src/` is compiled with no ambient Node
  types at all, so it cannot read a file, a clock, or an environment variable.
- **Deterministic.** The same context always yields the same decision. No
  clock, no randomness, no I/O — which is what makes a stored decision record
  auditable rather than merely archived.
- **Explainable.** A held proposal says which requirement is unmet, in a
  sentence a person can read.
- **Domain-independent.** Nothing here knows what your knowledge is *about*.

## Running a review, not just deciding one

A decision is a moment; a review is a sequence of them over days. Three pieces
cover the parts of that sequence which are the same in every domain:

- **`AssuranceStore`** — the persistence *port*. An interface your store
  implements, not a storage layer this package owns. It carries governance
  history: assessments, disputes and their rulings, decisions against a
  version. It deliberately cannot create a proposal, append a version, or
  publish — those are your acts, over content this package cannot read.
- **`runStoreConformance`** — the contract, executable. A TypeScript interface
  states shapes and nothing else; it cannot say that a revision must not
  inherit the previous version's approvals. That clause and a dozen others are
  checked against your adapter, and the suite returns plain results so you
  assert on them in whatever test framework you already use. No framework
  dependency comes with it.
- **`selectReviewQueue`** and **`sealReviewPacket`** — who gets asked to review
  what, and what they are allowed to see. The packet guard is the one worth
  knowing about: it refuses to seal a reviewer's packet that carries another
  reviewer's verdict or the running tally, so blind review survives the next
  adapter written by someone who never read the query that was careful.

`MemoryAssuranceStore` implements the port in memory for tests and examples.
It is the same store the conformance suite runs against, so "what the contract
means" and "what the reference does" cannot drift apart.

## What it deliberately leaves to you

Three things, each because centralising them would be wrong rather than hard:

1. **Persistence.** The core describes the shape of your store and never holds
   it. Extracting a storage layer instead would mean shipping a driver, and
   the zero-dependency property is most of why this is worth taking.
2. **Publishing.** Writing a change into your knowledge base is the one part
   that does not generalise: what "applied" means differs completely between a
   reference work, a decision log and a rulebook. There is no `publish` here
   and there will not be one.
3. **Actor resolution and projection.** You authenticate the caller and hand
   down an `ActorContext`; the core never authenticates anybody. How an
   `AssuranceProfile` appears to readers — a numeric level, a badge, a traffic
   light, a sentence — is a product decision. The core takes no position, and
   deliberately has no universal score: collapsing the profile into one number
   destroys the distinction it exists to carry. "Two agents agreed but no human
   looked" and "one high-tier model approved" are different states, and no
   single integer says both.

## Two hosts, one of them not the original

`examples/adr-host/` is a complete second host — an architecture-decision log
with its own tables, its own integer keys and its own idea of what a change is
— wired to this package afterwards rather than designed around it. It runs a
review end to end (`npm run example:host`), and its store adapter is put
through `runStoreConformance` in the package's own test suite.

That is the only real check that this core is domain-independent, and it paid
for itself immediately. Building it found three things no amount of reading
would have:

- The conformance suite was choosing row ids. No store worth having lets a
  caller name the key of a row it is about to create, so the contract changed:
  the harness now returns the ids the host assigned. The same turned out to be
  true of the target itself.
- A host that governs one collection cannot demonstrate that listing is scoped
  to a space. Those clauses are now reported as **skipped**, not passed — a
  green run that silently covers less is worse than a shorter one that says so.
- A real bug in the example host: `??` where `=== undefined` was meant, so
  every unsubmitted draft came back looking reviewable. Nothing in that host's
  own tests would have caught it, because nothing there reads the field.

## A worked example

From [`examples/adr-log.ts`](examples/adr-log.ts) — an architecture-decision
log, chosen because it has nothing in common with the domain this core was
extracted from. Run it with `npm run example`.

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

```
adr-review@v1: held — assurance.humanApproval (0 human approval(s))
  blocked by: at least one approval from a human
```

Swap one agent for a principal engineer — same quorum, different composition:

```
adr-review@v1: allowed
```

That is the whole idea. *How many* approvals is rarely the interesting
question; *whose*, and *of what kind*, usually is.

## Concepts

| Concept | What it carries |
| --- | --- |
| `ActorContext` | The caller as the host resolved it: identity, kind, capabilities. |
| `Assessment` | One reviewer's verdict on one proposal version: `approve`, `dispute`, `abstain`. |
| `AssuranceProfile` | What a version has actually accumulated — counts, composition, capabilities. Built by `tallyAssurance`. |
| `RiskProfile` | The host's classification: a level plus free-form tags. The core never computes this. |
| `Requirement` | A composable, self-explaining predicate: `independentApprovals(2)`, `humanApproval()`, … |
| `PolicySet` | Versioned rules. Built with `policy(id, version)`, evaluated against a `PolicyContext`. |
| `PolicyDecision` | The auditable output: allowed or held, which rule, which requirements, and a fingerprint of the inputs. |

### Two distinctions worth understanding early

**`capabilities` vs `assuranceCapabilities`.** The first gate *actions* — what
this actor is allowed to do. The second gate *publication requirements* — and
are **server-owned**. That is a security boundary, not a naming convention: a
value the caller could have chosen must never be an assurance capability, or an
actor satisfies a requirement simply by claiming to. A model string an agent
reports about itself is audit metadata; the tier your server recorded when the
assessment was written is an assurance capability.

**Design target vs effective quorum.** A policy states the quorum it wants. A
small reviewer pool may not be able to reach it. `ReviewerPoolState` carries
both, plus `degraded`, so a decision made under a reduced quorum records that
it was — rather than silently looking like a decision made under the full one.

## Versioning and decision records

Every decision records the policy id **and version** it was made under. A later
policy change therefore cannot retroactively imply that older content was
published under the new rule. Requirement ids and rule ids are stable strings
that end up in persisted records: renaming one is a breaking change, and rule
ids are given explicitly rather than derived from position so that reordering a
file cannot silently re-point historical records at a different rule.

## Development

```
npm install
npm test          # 131 tests, no database, under a second
npm run typecheck # src, tests and examples
npm run example
npm run build
```

`tests/purity.test.ts` enforces the claims at the top of this file: no
non-relative import anywhere in `src/`, no declared dependencies, no clock or
randomness, and no host-domain vocabulary — **in comments as well as code**.
That last part is deliberate. When this core was extracted, its code was
already clean while its doc comments named the original host more than twenty
times and pointed at files that do not exist in this repository. A comment
describing a codebase the reader cannot open is worse than no comment.

## Releasing

Publishing is driven by GitHub releases. Bump `version` in `package.json`, land
it, then publish a release whose tag is that version (`v0.1.0` or `0.1.0` —
both are accepted). `.github/workflows/publish.yml` refuses a tag that does not
match the version in the tree, so a release cannot ship one version under
another's name.

`prepublishOnly` runs typecheck, tests and build before the upload, so the gate
travels with the package rather than living only in CI — a publish by hand from
a laptop is held to the same bar. The workflow publishes with `--provenance`,
which attaches a signed attestation tying the tarball to the workflow run and
commit that produced it.

It needs an `NPM_TOKEN` repository secret holding an npm automation token with
publish rights. Until that exists the publish step fails rather than reporting
a success it did not achieve.

## Status

`0.2.0`, and honest about it. It adds the store port, the conformance suite,
the review queue and the review packet — a larger addition than the core it
joins. Two hosts use it: the reference work it was extracted from, and the ADR
log in `examples/`. The second one is deliberately small, so "it fits two
domains" is a real claim about a modest range rather than a large one. Expect
the surface to move before `1.0`.

## Licence

MIT
