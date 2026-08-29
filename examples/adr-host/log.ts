/**
 * The host's own world: an architecture-decision log.
 *
 * Nothing in this file knows that `assurance-core` exists. That is the point —
 * it is written the way a host would have written it anyway, with its own
 * tables, its own integer keys and its own idea of what a change is, and the
 * governance wiring is added around it afterwards. A "second host" assembled
 * out of the core's own vocabulary would prove nothing about whether the core
 * fits a domain it did not come from.
 */

export type AdrStatus = 'draft' | 'proposed' | 'accepted' | 'superseded';

export interface Adr {
  readonly number: number;
  title: string;
  status: AdrStatus;
  context: string;
  decision: string;
  /** ADR numbers this one replaces. Non-empty makes a change consequential. */
  supersedes: number[];
  revision: number;
}

/** A proposed change to one ADR, before anyone has agreed to it. */
export interface ChangeRequest {
  readonly id: number;
  readonly adrNumber: number;
  readonly openedBy: string;
  /** Successive drafts. The last one is what reviewers see. */
  readonly drafts: Draft[];
  state: 'open' | 'merged' | 'withdrawn';
  readonly openedAt: Date;
}

export interface Draft {
  readonly id: number;
  readonly title: string;
  readonly context: string;
  readonly decision: string;
  readonly supersedes: number[];
  readonly writtenBy: string;
  readonly writtenAt: Date;
  submittedAt: Date | null;
}

/**
 * The whole log, in memory.
 *
 * A real host would put this in a database; what matters for the example is
 * that the shapes are the host's, not the core's, so the adapter has real
 * translation to do rather than passing objects straight through.
 */
export class AdrLog {
  private readonly adrs = new Map<number, Adr>();
  private readonly changes = new Map<number, ChangeRequest>();
  private nextChangeId = 1;
  private nextDraftId = 1;

  addAdr(input: Omit<Adr, 'revision' | 'supersedes'> & { supersedes?: number[] }): Adr {
    const adr: Adr = {
      ...input,
      supersedes: input.supersedes ?? [],
      revision: 1,
    };
    this.adrs.set(adr.number, adr);
    return adr;
  }

  adr(number: number): Adr | undefined {
    return this.adrs.get(number);
  }

  openChange(input: {
    adrNumber: number;
    openedBy: string;
    at: Date;
  }): ChangeRequest {
    const change: ChangeRequest = {
      id: this.nextChangeId++,
      adrNumber: input.adrNumber,
      openedBy: input.openedBy,
      drafts: [],
      state: 'open',
      openedAt: input.at,
    };
    this.changes.set(change.id, change);
    return change;
  }

  addDraft(
    changeId: number,
    input: Omit<Draft, 'id' | 'submittedAt'> & { submittedAt?: Date | null },
  ): Draft {
    const change = this.mustChange(changeId);
    const draft: Draft = {
      ...input,
      id: this.nextDraftId++,
      // `??` would be wrong here and was: an explicit `null` means "written
      // but not submitted", and `??` treats it as absent, so every unsubmitted
      // draft came back stamped with its authoring time and looked reviewable.
      // The port's conformance suite caught it; nothing in this host's own
      // tests would have, because nothing here reads the field.
      submittedAt: input.submittedAt === undefined ? input.writtenAt : input.submittedAt,
    };
    change.drafts.push(draft);
    return draft;
  }

  change(id: number): ChangeRequest | undefined {
    return this.changes.get(id);
  }

  openChanges(): ChangeRequest[] {
    return [...this.changes.values()]
      .filter((c) => c.state === 'open')
      .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  }

  draft(id: number): { change: ChangeRequest; draft: Draft } | undefined {
    for (const change of this.changes.values()) {
      const draft = change.drafts.find((d) => d.id === id);
      if (draft) return { change, draft };
    }
    return undefined;
  }

  /**
   * Apply a draft to the log — the host act the core has no primitive for.
   *
   * Everything specific to this domain lives here: bumping a revision,
   * flipping the superseded records' status, and closing the change request.
   * None of it would mean anything in another host, which is exactly why
   * publishing stays on this side of the boundary.
   */
  merge(draftId: number): Adr {
    const found = this.draft(draftId);
    if (!found) throw new Error(`no draft ${draftId}`);
    const { change, draft } = found;
    const adr = this.adrs.get(change.adrNumber);
    if (!adr) throw new Error(`no ADR ${change.adrNumber}`);

    adr.title = draft.title;
    adr.context = draft.context;
    adr.decision = draft.decision;
    adr.supersedes = [...draft.supersedes];
    adr.status = 'accepted';
    adr.revision += 1;

    for (const number of draft.supersedes) {
      const replaced = this.adrs.get(number);
      if (replaced) replaced.status = 'superseded';
    }
    change.state = 'merged';
    return adr;
  }

  private mustChange(id: number): ChangeRequest {
    const change = this.changes.get(id);
    if (!change) throw new Error(`no change request ${id}`);
    return change;
  }
}
