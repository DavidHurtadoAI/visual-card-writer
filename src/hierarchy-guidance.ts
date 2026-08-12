import type { ParseIssue } from "./types";

export interface HierarchyGuidance {
  title: string;
  explanation: string;
  resolution: string;
}

export function getHierarchyGuidance(issue: ParseIssue): HierarchyGuidance {
  if (issue.kind === "level-jump") {
    const missingLevel = issue.expectedLevel;
    return {
      title: `An H${missingLevel} is missing before this H${issue.currentLevel}`,
      explanation: `Line ${issue.line} jumps from H${issue.previousLevel} to H${issue.currentLevel}. Visual Card Writer has inferred this card as a direct child, but the Markdown omits H${missingLevel}.`,
      resolution: `Change the H${issue.currentLevel} to H${missingLevel}, or add an H${missingLevel} heading before it to act as its parent.`
    };
  }

  if (issue.kind === "missing-root") {
    return {
      title: `The first card heading is H${issue.currentLevel}`,
      explanation: `Line ${issue.line} starts below H1. Visual Card Writer needs an H1 as the root of the card tree.`,
      resolution: "Change the first heading to H1, or add an H1 before it."
    };
  }

  return {
    title: "No card headings were found",
    explanation: "Visual Card Writer uses Markdown headings to build the card tree.",
    resolution: "Add an H1 heading to start the document."
  };
}
