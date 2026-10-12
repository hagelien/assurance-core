/**
 * The blind-review guard.
 *
 * Every test here is about one property: a reviewer must not see another
 * reviewer's judgment before forming their own. The guard is a blunt substring
 * scan, and blunt is the point — the thing it defends against is a field name
 * nobody thought of, so a list of exact names would lose that race by
 * construction.
 */
import { describe, expect, it } from 'vitest';
import {
  PEER_SIGNAL_STEM_LIST,
  ReviewPacketLeakError,
  sealReviewPacket,
  type ReviewableVersion,
} from '../src/index.js';

const version: ReviewableVersion = {
  ref: { proposalId: 'p1', versionId: 'v1' },
  target: { space: 's', type: 'note', id: 'n1' },
  targetVersion: 'rev-7',
  createdAt: '2020-01-01T00:00:00.000Z',
  authorRef: 'user:1',
};

describe('a clean packet seals', () => {
  it('carries the version, the token and the payload through', () => {
    const packet = sealReviewPacket({
      version,
      proposed: { title: 'A', body: 'B' },
      current: { title: 'A0' },
      evidence: [{ kind: 'source', id: '12345' }],
      evidenceRequirements: [
        { id: 'cited', kind: 'source', description: 'cite a source', blocking: true },
      ],
      context: { risk: 'low' },
    });
    expect(packet.target).toEqual(version.target);
    expect(packet.proposalVersionId).toBe('v1');
    expect(packet.targetVersion).toBe('rev-7');
    expect(packet.authorRef).toBe('user:1');
    expect(packet.proposed).toEqual({ title: 'A', body: 'B' });
    expect(packet.evidence).toHaveLength(1);
  });

  it('is frozen, so a later caller cannot add a peer signal after the scan', () => {
    const packet = sealReviewPacket({ version, proposed: { title: 'A' } });
    expect(Object.isFrozen(packet)).toBe(true);
  });

  it('defaults the optional sections rather than leaving them undefined', () => {
    const packet = sealReviewPacket({ version, proposed: {} });
    expect(packet.current).toEqual({});
    expect(packet.evidence).toEqual([]);
    expect(packet.evidenceRequirements).toEqual([]);
    expect(packet.context).toEqual({});
  });
});

describe('a packet carrying a peer signal is refused', () => {
  it.each(PEER_SIGNAL_STEM_LIST)('refuses a key containing %s', (stem) => {
    expect(() =>
      sealReviewPacket({ version, proposed: { [`${stem}Field`]: 1 } }),
    ).toThrow(ReviewPacketLeakError);
  });

  it('catches the case exact matching missed', () => {
    // `approvalCounts` normalises to `approvalcounts`, which equals neither
    // `approvals` nor `approvalcount`. The first version of this guard matched
    // exact names and sealed it cleanly.
    expect(() =>
      sealReviewPacket({ version, proposed: { approvalCounts: 3 } }),
    ).toThrow(ReviewPacketLeakError);
  });

  it('sees through punctuation and casing', () => {
    for (const key of ['Peer_Review', 'HOLD-REASON', 'q u o r u m']) {
      expect(() => sealReviewPacket({ version, proposed: { [key]: 1 } })).toThrow(
        ReviewPacketLeakError,
      );
    }
  });

  it('scans at depth, not just the top level', () => {
    expect(() =>
      sealReviewPacket({
        version,
        proposed: { outer: { inner: [{ verdictSummary: 'approved' }] } },
      }),
    ).toThrow(/proposed\.outer\.inner\[0\]\.verdictSummary/);
  });

  it('scans every host-shaped section, not only the payload', () => {
    for (const section of ['current', 'context'] as const) {
      expect(() =>
        sealReviewPacket({ version, proposed: {}, [section]: { quorum: 2 } }),
      ).toThrow(ReviewPacketLeakError);
    }
    expect(() =>
      sealReviewPacket({
        version,
        proposed: {},
        evidence: [{ kind: 'k', id: '1', summary: { consensusNote: 'x' } }],
      }),
    ).toThrow(ReviewPacketLeakError);
  });

  it('names the path, so an adapter author can find the field', () => {
    try {
      sealReviewPacket({ version, proposed: { a: { b: { approvals: 2 } } } });
      throw new Error('expected a leak error');
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewPacketLeakError);
      expect((error as ReviewPacketLeakError).path).toBe('proposed.a.b.approvals');
    }
  });
});

describe('a host may allow keys that are the object under review, not a peer signal', () => {
  // A domain where the reviewed object is itself a judgment — a summary of a
  // court's verdict, say — legitimately carries a key the guard would ban.
  it('refuses such a key unless the host allows it', () => {
    expect(() =>
      sealReviewPacket({ version, proposed: { verdictSummary: 'Upheld on appeal.' } }),
    ).toThrow(ReviewPacketLeakError);
  });

  it('seals it once the host names it, in any spelling', () => {
    const packet = sealReviewPacket({
      version,
      proposed: { verdictSummary: 'Upheld on appeal.' },
      allowKeys: ['verdict_summary'],
    });
    expect(packet.proposed.verdictSummary).toBe('Upheld on appeal.');
  });

  it('does not let the escape hatch widen by substring', () => {
    // `verdictSummaryOfPeers` is not `verdictsummary`. If the allow-list were
    // matched by stem the way the ban is, this would seal.
    expect(() =>
      sealReviewPacket({
        version,
        proposed: { verdictSummaryOfPeers: 'two approve' },
        allowKeys: ['verdictSummary'],
      }),
    ).toThrow(ReviewPacketLeakError);
  });

  it('reaches only the content under review, never the context or the evidence', () => {
    // Allowed because it is legitimate in a proposal; the same name in the
    // context is another reviewer's judgment arriving by the side door.
    expect(() =>
      sealReviewPacket({
        version,
        proposed: {},
        context: { verdictSummary: 'two approve' },
        allowKeys: ['verdictSummary'],
      }),
    ).toThrow(ReviewPacketLeakError);
    expect(() =>
      sealReviewPacket({
        version,
        proposed: {},
        evidence: [{ kind: 'note', id: 'e1', summary: { verdictSummary: 'upheld' } }],
        allowKeys: ['verdictSummary'],
      }),
    ).toThrow(ReviewPacketLeakError);
    expect(
      sealReviewPacket({
        version,
        proposed: { verdictSummary: 'new text' },
        current: { verdictSummary: 'old text' },
        allowKeys: ['verdictSummary'],
      }).current.verdictSummary,
    ).toBe('old text');
  });

  it('allows no host field by default', () => {
    // The core once carried one host's field names here. Every host's own
    // content keys are its own to declare.
    expect(() =>
      sealReviewPacket({ version, proposed: { approvalNote: 'x' } }),
    ).toThrow(ReviewPacketLeakError);
  });
});

describe('the packet names the whole version', () => {
  it('carries both halves of the reference', () => {
    const packet = sealReviewPacket({ version, proposed: {} });
    expect(packet.proposalVersion).toEqual(version.ref);
    expect(packet.proposalVersionId).toBe(version.ref.versionId);
  });
});

describe('the scan terminates', () => {
  it('survives a cycle', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => sealReviewPacket({ version, proposed: cyclic })).not.toThrow();
  });

  it('walks a shared subtree once without mistaking it for a cycle', () => {
    const shared = { title: 'A' };
    const packet = sealReviewPacket({
      version,
      proposed: { first: shared, second: shared },
    });
    expect(packet.proposed.first).toBe(shared);
  });

  it('still catches a leak inside a shared subtree', () => {
    // The de-duplication must not become a way to smuggle one past: the first
    // walk has to do the checking.
    const shared = { verdict: 'approve' };
    expect(() =>
      sealReviewPacket({ version, proposed: { first: shared, second: shared } }),
    ).toThrow(ReviewPacketLeakError);
  });
});
