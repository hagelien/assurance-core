/**
 * The package's central claim, asserted rather than described.
 *
 * `assurance-core` is worth extracting only if it stays free of any one
 * host's world. That is easy to state in a README and easy to lose one
 * convenient import at a time, so it is checked here on every run.
 *
 * ## Why comments are checked too
 *
 * The suite this file replaces stripped comments before scanning for host
 * vocabulary, on the reasoning that only code can create a dependency. That is
 * true of *dependencies* and false of *documentation*. When this core was
 * extracted, its code was already clean while its doc comments named the
 * original host more than twenty times and pointed at file paths — a
 * `projection.ts`, an `agent-verifications.ts` — that do not exist in this
 * repository and never will. A comment describing a codebase the reader cannot
 * open is worse than no comment: it is a confident answer to "why is this
 * here?" that cannot be checked and quietly misleads.
 *
 * So the scan below reads whole files. A host name in a comment fails just as
 * a host import would.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC);

/** Report offenders by path, so a failure names the file rather than a count. */
function offenders(predicate: (text: string, file: string) => boolean): string[] {
  return FILES.filter((file) =>
    predicate(fs.readFileSync(file, 'utf8'), file),
  ).map((file) => path.relative(ROOT, file));
}

describe('the scan looks at the right files', () => {
  // Guard the guard. Every assertion below is a filter over FILES, and a
  // filter over nothing passes forever — the exact shape of failure this
  // package's whole design is meant to avoid.
  it('finds the core modules', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(8);
    const names = FILES.map((f) => path.basename(f)).sort();
    expect(names).toContain('index.ts');
    expect(names).toContain('policy.ts');
    expect(names).toContain('assurance.ts');
  });

  it('reads real content, not empty files', () => {
    for (const file of FILES) {
      expect(fs.readFileSync(file, 'utf8').length).toBeGreaterThan(200);
    }
  });
});

describe('zero runtime dependencies', () => {
  it('imports nothing outside itself', () => {
    // Every import must be relative. Not "no database driver" — nothing at
    // all, including Node built-ins: a core that reads a file or a clock is no
    // longer deterministic, and determinism is what makes a decision record
    // auditable a year later.
    const bad = offenders((text) =>
      [...text.matchAll(/from\s+'([^']+)'/g)].some(
        (m) => !m[1]!.startsWith('.'),
      ),
    );
    expect(bad).toEqual([]);
  });

  it('declares no dependencies in package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('reaches no network and touches no clock or randomness', () => {
    const bad = offenders((text) =>
      /\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\/[a-z]|\bDate\.now\b|\bnew Date\b|Math\.random/.test(
        text,
      ),
    );
    expect(bad).toEqual([]);
  });
});

describe('no host domain leaks in, in code or in prose', () => {
  // Terms from the host this core was extracted from, plus the shapes a future
  // leak would most likely take. A term appearing here is not a judgment about
  // that host — it is a tripwire for the direction the leak historically came
  // from.
  const FORBIDDEN = [
    'kinetix',
    'pharmac',
    'pharmacokinetic',
    'halflife',
    'half_life',
    'dosage',
    'clinician',
    'pubmed',
    'drizzle',
    'neon',
    'postgres',
    'react',
  ];

  it.each(FORBIDDEN)('names no `%s` anywhere in src/', (term) => {
    const bad = offenders((text) => text.toLowerCase().includes(term));
    expect(bad).toEqual([]);
  });

  it('points at no file path outside this package', () => {
    // The failure mode that motivated this file: a comment referring to
    // `src/lib/...` or `api/_lib/...` in some other repository. Such a path
    // cannot be followed, cannot be verified, and rots silently.
    const bad = offenders((text) => /\b(api|src)\/_?lib\//.test(text));
    expect(bad).toEqual([]);
  });

  it('cites no section of a document this package does not contain', () => {
    // Comments in the original referenced "§7.2 of the extraction plan". The
    // plan is not here, so the citation is unresolvable to any reader of this
    // package.
    const bad = offenders((text) => /§\s*\d/.test(text));
    expect(bad).toEqual([]);
  });

  it('would actually catch a leak', () => {
    // Non-vacuity for the block above: prove the predicate fires on text that
    // does contain a forbidden term, so a passing run means "searched and
    // found nothing" rather than "the search was broken".
    const detect = (text: string) =>
      FORBIDDEN.some((term) => text.toLowerCase().includes(term));
    expect(detect('the Kinetix projection does this')).toBe(true);
    expect(detect('a host projects this profile')).toBe(false);
  });
});
