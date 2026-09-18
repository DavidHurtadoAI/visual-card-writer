import type { TFile, Workspace, WorkspaceLeaf } from "obsidian";
import type { MarkdownOpenLocation } from "./settings";

/** Navigate by source line so duplicate heading titles remain unambiguous. */
export async function openCardInMarkdown(
  workspace: Workspace,
  source: WorkspaceLeaf,
  file: Pick<TFile, "path">,
  line: number,
  location: MarkdownOpenLocation,
  previous?: WorkspaceLeaf
): Promise<WorkspaceLeaf> {
  const leaf = previous && previous !== source && workspace.getLeavesOfType("markdown").includes(previous)
    ? previous
    : location === "right"
      ? workspace.createLeafBySplit(source, "vertical", false)
      : workspace.getLeaf("tab");
  await leaf.setViewState({
    type: "markdown",
    state: { file: file.path, mode: "source" },
    active: true
  }, { line: Math.max(0, line - 1), focus: true });
  await workspace.revealLeaf(leaf);
  return leaf;
}
