/**
 * Where this package stops, asserted rather than described.
 *
 * Two boundaries are load-bearing, and both are the kind that erode by
 * accident rather than by decision — one convenient export at a time, each
 * individually defensible.
 *
 * **Publishing stays with the host.** Writing a change into a body of
 * knowledge is the one part that does not generalise: what "applied" means
 * differs completely between a reference work, a decision log and a rulebook,
 * and the write goes to tables only the host has. A publish primitive here
 * would have to either guess at that or take a driver, and both are how this
 * package would stop being worth taking.
 *
 * **Persistence stays with the host.** The port describes the memory; it does
 * not hold it.
 *
 * The temptation in both cases is real, which is why they are checked. An
 * `applyDecision` that "just" calls a host callback looks harmless and moves
 * the responsibility for ordering, transactions and failure into a package
 * that can see none of them.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Every exported name, values and types alike. */
function exportedNames(): string[] {
  const names = new Set<string>(Object.keys(core));
  for (const entry of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (!entry.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(ROOT, 'src', entry), 'utf8');
    for (const m of source.matchAll(
      /export (?:const|function|class|interface|type|abstract class) (\w+)/g,
    )) {
      names.add(m[1]!);
    }
  }
  return [...names];
}

describe('the exported surface', () => {
  it('is large enough for the absences below to mean something', () => {
    // A scan that found nothing would make every "does not export" assertion
    // pass at once.
    const names = exportedNames();
    expect(names.length).toBeGreaterThan(40);
    expect(names).toContain('tallyAssurance');
    expect(names).toContain('AssuranceStore');
    expect(names).toContain('sealReviewPacket');
  });

  it('offers no way to publish, apply, or write to a host', () => {
    const forbidden =
      /^(apply|publish|commit|write|persist|save|merge)[A-Z]|^(Apply|Publish)[A-Z]/;
    for (const name of exportedNames()) {
      expect(name, `exports ${name}`).not.toMatch(forbidden);
    }
  });

  it('offers no store implementation beyond the in-memory reference', () => {
    // The reference store exists for tests and examples and says so. A second
    // implementation here would mean the package had acquired a driver.
    // Matched on the type-ish names only: `memoryStore` and
    // `candidatesFromStore` are a factory and a query, not implementations.
    const stores = exportedNames().filter((n) => /^[A-Z]\w*Store$/.test(n));
    expect(stores.sort()).toEqual(['AssuranceStore', 'MemoryAssuranceStore']);
  });

  it('lets the store create no proposal, version, or publication', () => {
    // The port's own absences, checked against its declaration rather than
    // against an implementation that might simply not have got round to them.
    const port = fs.readFileSync(path.join(ROOT, 'src/store.ts'), 'utf8');
    const methods = [
      ...port.matchAll(/^\s{2}(\w+)\(/gm),
    ].map((m) => m[1]!);
    expect(methods.length).toBeGreaterThan(8);
    for (const forbidden of [
      'createProposal',
      'appendVersion',
      'publish',
      'apply',
      'setProposalState',
      'deleteAssessment',
      'updateAssessment',
      'recordPublication',
    ]) {
      expect(methods, `port declares ${forbidden}`).not.toContain(forbidden);
    }
    // And the reads it does declare are still there, so the list above was
    // compared against something.
    expect(methods).toContain('recordAssessment');
    expect(methods).toContain('currentAssessments');
  });
});

describe('the review machinery reaches nothing on its own', () => {
  it('takes its store as an argument rather than constructing one', () => {
    // A module-level default store would be a global the host cannot replace,
    // and the first step toward this package owning a connection.
    const queue = fs.readFileSync(path.join(ROOT, 'src/queue.ts'), 'utf8');
    expect(queue).not.toMatch(/new MemoryAssuranceStore|memoryStore\(\)/);
    expect(queue).toMatch(/store: AssuranceStore/);
  });

  it('keeps the reference store out of what the core imports', () => {
    // `store-memory.ts` may import the port; nothing but the barrel and the
    // tests may import `store-memory.ts`. Otherwise the reference
    // implementation ends up in a production bundle by way of a core module.
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(path.join(ROOT, 'src'))) {
      if (!entry.endsWith('.ts') || entry === 'index.ts') continue;
      if (entry === 'store-memory.ts') continue;
      const source = fs.readFileSync(path.join(ROOT, 'src', entry), 'utf8');
      if (source.includes("from './store-memory.js'")) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});
