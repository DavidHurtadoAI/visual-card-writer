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

  it("asks for a heading without requiring H1 or changing source", () => {
    const guidance = getHierarchyGuidance({
      kind: "no-headings",
      line: 1,
      message: "No structural headings."
    });

    expect(guidance.title).toContain("No card headings");
    expect(guidance.resolution).toContain("H1–H6");
  });
});
