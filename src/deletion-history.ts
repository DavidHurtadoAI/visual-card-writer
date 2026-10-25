interface Deletion {
  before: string;
  after: string;
  selectedBefore: string | null;
  selectedAfter: string | null;
}

/** Conditional history: never overwrite a subsequent edit from another view. */
export class DeletionHistory {
  private past: Deletion[] = [];
  private future: Deletion[] = [];

  clear(): void { this.past = []; this.future = []; }

  record(change: Deletion): void {
    if (this.past[this.past.length - 1]?.after !== change.before) this.past = [];
    this.past.push(change);
    // Bound memory as well as entry count for long notes.
    while (this.past.length > 20 || (this.past.length > 1 && this.past.reduce((n, item) => n + item.before.length + item.after.length, 0) > 5_000_000)) this.past.shift();
    this.future = [];
  }

  canUndo(text: string): boolean { return this.past[this.past.length - 1]?.after === text; }
  canRedo(text: string): boolean { return this.future[this.future.length - 1]?.before === text; }

  undo(text: string): { text: string; selectedCardId: string | null } | null {
    if (!this.canUndo(text)) return null;
    const change = this.past.pop()!;
    this.future.push(change);
    return { text: change.before, selectedCardId: change.selectedBefore };
  }

  redo(text: string): { text: string; selectedCardId: string | null } | null {
    if (!this.canRedo(text)) return null;
    const change = this.future.pop()!;
    this.past.push(change);
    return { text: change.after, selectedCardId: change.selectedAfter };
  }
}
