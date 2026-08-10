export type SessionChangeKind = "initial" | "local" | "external";

export interface SessionSnapshot {
  path: string;
  text: string;
  revision: number;
  kind: SessionChangeKind;
  source: object | null;
}

export type SessionListener = (snapshot: SessionSnapshot) => void;

export class DocumentSession {
  readonly path: string;
  private currentText: string;
  private currentRevision = 0;
  private listeners = new Set<SessionListener>();

  constructor(path: string, initialText: string) {
    this.path = path;
    this.currentText = initialText;
  }

  get text(): string {
    return this.currentText;
  }

  get revision(): number {
    return this.currentRevision;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  commit(text: string, source: object, kind: Exclude<SessionChangeKind, "initial">): SessionSnapshot {
    if (text === this.currentText) {
      return this.snapshot(kind, source);
    }
    this.currentText = text;
    this.currentRevision += 1;
    const snapshot = this.snapshot(kind, source);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  snapshot(kind: SessionChangeKind = "initial", source: object | null = null): SessionSnapshot {
    return {
      path: this.path,
      text: this.currentText,
      revision: this.currentRevision,
      kind,
      source
    };
  }
}

interface RegistryEntry {
  session: DocumentSession;
  references: number;
}

export interface SessionRegistryDiagnostics {
  sessions: number;
  entries: Array<{ path: string; revision: number; references: number; dataLength: number }>;
}

export class DocumentSessionRegistry {
  private entries = new Map<string, RegistryEntry>();

  get(path: string): DocumentSession | null {
    return this.entries.get(path)?.session ?? null;
  }

  acquire(path: string, initialText: string): DocumentSession {
    const existing = this.entries.get(path);
    if (existing) {
      existing.references += 1;
      return existing.session;
    }
    const session = new DocumentSession(path, initialText);
    this.entries.set(path, { session, references: 1 });
    return session;
  }

  release(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) {
      return;
    }
    entry.references -= 1;
    if (entry.references <= 0) {
      this.entries.delete(path);
    }
  }

  diagnostics(): SessionRegistryDiagnostics {
    return {
      sessions: this.entries.size,
      entries: [...this.entries.entries()].map(([path, entry]) => ({
        path,
        revision: entry.session.revision,
        references: entry.references,
        dataLength: entry.session.text.length
      }))
    };
  }

  clear(): void {
    this.entries.clear();
  }
}
