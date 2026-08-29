/**
 * `assurance-core` — the public surface.
 *
 * This package answers one question: given who has assessed a proposed change
 * and what they concluded, may it publish yet? It knows how to count reviews,
 * how to weigh who did the reviewing, and how to explain a refusal. It
 * classifies nothing about the subject matter, because it cannot — the domain
 * belongs to the host.
 *
 * The layer is pure. No database driver, no ORM, no HTTP request objects, no
 * UI framework, no network, and nothing about any particular field of
 * knowledge. Everything it needs arrives as an argument and everything it
 * produces is a value. That is not incidental: it is what lets one policy
 * engine serve a scientific reference, a legal knowledge base and an
 * architecture-decision log without any of them acquiring the others'
 * assumptions.
 *
 * A host supplies three things this package deliberately lacks: persistence,
 * an actor's capabilities, and a projection of an `AssuranceProfile` into
 * whatever its interface shows readers. The projection in particular stays
 * with the host — a numeric review level, a badge, a traffic light and a plain
 * sentence are all faithful renderings of the same profile, and the core takes
 * no position on which.
 *
 * Persistence is *described* here even though it is not provided:
 * `AssuranceStore` is the interface a host implements, `MemoryAssuranceStore`
 * is a reference implementation for tests and examples, and
 * `runStoreConformance` is the executable contract a host runs against its own
 * adapter. Describing the port here rather than letting each host invent one
 * is what lets the review machinery above it be written once.
 */

export * from './types.js';
export * from './actors.js';
export * from './risk.js';
export * from './assurance.js';
export * from './requirements.js';
export * from './policy.js';
export * from './decisions.js';
export * from './store.js';
export * from './store-memory.js';
export * from './store-conformance.js';
export * from './review-packet.js';
export * from './queue.js';
