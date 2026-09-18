import { describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceLeaf } from "obsidian";
import { openCardInMarkdown } from "../src/open-card";
import { parseCardDocument } from "../src/parser";

function setup() {
  const sourceState = vi.fn();
  const targetState = vi.fn().mockResolvedValue(undefined);
  const source = { setViewState: sourceState } as unknown as WorkspaceLeaf;
  const target = { setViewState: targetState } as unknown as WorkspaceLeaf;
  const workspace = {
    getLeavesOfType: vi.fn().mockReturnValue([]),
    getLeaf: vi.fn().mockReturnValue(target),
    createLeafBySplit: vi.fn().mockReturnValue(target),
    revealLeaf: vi.fn().mockResolvedValue(undefined)
  };
  return { source, target, sourceState, targetState, workspace, api: workspace as unknown as Workspace, file: { path: "Note.md" } };
}

describe("opening cards in Obsidian", () => {
  it("opens a tab at the precise occurrence of a duplicate heading, preserving the card view", async () => {
    const { source, target, sourceState, targetState, workspace, api, file } = setup();
    const document = parseCardDocument("# Root\n\n## Same\nFirst\n\n## Same\nSecond\n");
    await openCardInMarkdown(api, source, file, document.cards[2].range.line, "tab");
    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(targetState).toHaveBeenCalledWith({
      type: "markdown", state: { file: "Note.md", mode: "source" }, active: true
    }, { line: 5, focus: true });
    expect(sourceState).not.toHaveBeenCalled();
    expect(workspace.revealLeaf).toHaveBeenCalledWith(target);
  });

  it("splits to the right of the card view even if another pane is active", async () => {
    const { source, workspace, api, file } = setup();
    await openCardInMarkdown(api, source, file, 1, "right");
    expect(workspace.createLeafBySplit).toHaveBeenCalledWith(source, "vertical", false);
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("reuses an existing destination for successive cards", async () => {
    const { source, target, workspace, api, file } = setup();
    workspace.getLeavesOfType.mockReturnValue([target]);
    expect(await openCardInMarkdown(api, source, file, 8, "right", target)).toBe(target);
    expect(workspace.createLeafBySplit).not.toHaveBeenCalled();
    expect(workspace.getLeaf).not.toHaveBeenCalled();
  });

  it("recreates a destination after its editor is closed or switched to another view", async () => {
    const { source, target, workspace, api, file } = setup();
    const closed = {} as WorkspaceLeaf;
    expect(await openCardInMarkdown(api, source, file, 1, "right", closed)).toBe(target);
    expect(workspace.createLeafBySplit).toHaveBeenCalledOnce();
  });
});
