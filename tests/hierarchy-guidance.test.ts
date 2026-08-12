import { describe, expect, it } from "vitest";
import { getHierarchyGuidance } from "../src/hierarchy-guidance";

describe("getHierarchyGuidance", () => {
  it("explains a heading-level jump and gives both safe corrections", () => {
    const guidance = getHierarchyGuidance({
      kind: "level-jump",
      line: 7,
      message: "Heading jump from H1 to H3; H2 is missing.",
      previousLevel: 1,
      currentLevel: 3,
      expectedLevel: 2
    });

    expect(guidance.title).toContain("H2 is missing");
    expect(guidance.explanation).toContain("Line 7 jumps from H1 to H3");
    expect(guidance.resolution).toContain("Change the H3 to H2");
    expect(guidance.resolution).toContain("add an H2 heading");
  });

  it("explains why a root heading is required", () => {
    const guidance = getHierarchyGuidance({
      kind: "missing-root",
      line: 1,
      message: "The hierarchy must start at H1, not H3.",
      currentLevel: 3
    });

    expect(guidance.title).toContain("first card heading is H3");
    expect(guidance.resolution).toContain("add an H1");
  });
});
