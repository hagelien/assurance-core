# @assurance/core

Decide when a proposed change to a body of knowledge has been reviewed enough
to publish — and be able to explain the answer afterwards.

This package does **not** decide whether something is true. It computes how
well-attested a proposal is, applies a policy to that, and produces a decision
record you can re-read a year later and still understand.

```
npm install @assurance/core
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

## What it deliberately leaves to you

Three things, each because centralising them would be wrong rather than hard:

1. **Persistence.** The core is values in, values out.
2. **Actor resolution.** You authenticate the caller and hand down an
   `ActorContext`. The core never authenticates anybody.
3. **Projection.** How an `AssuranceProfile` appears to readers — a numeric
   level, a badge, a traffic light, a sentence — is a product decision. The
   core takes no position, and deliberately has no universal score: collapsing
   the profile into one number destroys the distinction it exists to carry.
   "Two agents agreed but no human looked" and "one high-tier model approved"
   are different states, and no single integer says both.

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

## Status

`0.1.0`, and honest about it: the API is in use but has been consumed by one
host so far. Expect the surface to move before `1.0`.

## Licence

MIT
