import { describe, expect, it, vi } from "vitest";
import { DocumentSession, DocumentSessionRegistry } from "../src/session";

describe("DocumentSession", () => {
  it("publishes local text with a monotonically increasing revision", () => {
    const session = new DocumentSession("Note.md", "# One\n");
    const listener = vi.fn();
    const source = {};
    session.subscribe(listener);

    const snapshot = session.commit("# One\nChanged\n", source, "local");

    expect(snapshot.revision).toBe(1);
    expect(session.text).toBe("# One\nChanged\n");
    expect(listener).toHaveBeenCalledWith(snapshot);
  });

  it("does not increment the revision for an identical commit", () => {
    const session = new DocumentSession("Note.md", "# One\n");
    const listener = vi.fn();
    session.subscribe(listener);

    session.commit("# One\n", {}, "external");

    expect(session.revision).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops publishing after unsubscribe", () => {
    const session = new DocumentSession("Note.md", "");
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    unsubscribe();

    session.commit("# One\n", {}, "local");

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("DocumentSessionRegistry", () => {
  it("shares one session for the same file and tracks references", () => {
    const registry = new DocumentSessionRegistry();
    const first = registry.acquire("Note.md", "# One\n");
    const second = registry.acquire("Note.md", "ignored");

    expect(second).toBe(first);
    expect(registry.diagnostics().entries[0]).toMatchObject({ references: 2, dataLength: 6 });
  });

  it("removes a session after its final release", () => {
    const registry = new DocumentSessionRegistry();
    registry.acquire("Note.md", "");
    registry.acquire("Note.md", "");

    registry.release("Note.md");
    expect(registry.diagnostics().sessions).toBe(1);
    registry.release("Note.md");
    expect(registry.diagnostics().sessions).toBe(0);
  });

  it("keeps different files in different sessions", () => {
    const registry = new DocumentSessionRegistry();

    expect(registry.acquire("One.md", "")).not.toBe(registry.acquire("Two.md", ""));
    expect(registry.diagnostics().sessions).toBe(2);
  });
});
