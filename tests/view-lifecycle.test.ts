import { describe, expect, it, vi } from "vitest";
import { VisualCardWriterView } from "../src/view";
import { parseCardDocument } from "../src/parser";

vi.mock("obsidian", () => ({ TextFileView: class {} }));

function harness(data: string | null) {
  const view = Object.assign(Object.create(VisualCardWriterView.prototype) as {
    data: string | null;
    onOpen(): Promise<void>;
    renderView(): Promise<void>;
  }, {
    data,
    containerEl: { addClass: vi.fn() },
    contentEl: {},
    focusDimming: { get: () => false },
    applyLayoutOrientationClass: vi.fn(),
    setFocusDimmingEnabled: vi.fn(),
    registerDomEvent: vi.fn(),
    addAction: vi.fn()
  });
  const render = vi.fn(async () => {
    // Obsidian calls onOpen before loading text; the parser only accepts text.
    parseCardDocument(view.data as string);
  });
  view.renderView = render;
  return { view, render };
}

describe("native file view lifecycle", () => {
  it("opens before Obsidian has supplied text without parsing or replacing the unloaded buffer", async () => {
    const { view, render } = harness(null);
    await expect(view.onOpen()).resolves.toBeUndefined();
    expect(view.data).toBeNull();
    expect(render).not.toHaveBeenCalled();
  });

  it.each(["", "# Root\n\n## Card\nExisting text\n"])("renders already-loaded text without modifying it (%j)", async (source) => {
    const { view, render } = harness(source);
    await expect(view.onOpen()).resolves.toBeUndefined();
    expect(render).toHaveBeenCalledOnce();
    expect(view.data).toBe(source);
  });
});
