import { describe, expect, it } from "vitest";
import {
  computeBranchAxisLayout,
  computeTreeLayout,
  getBranchCardIds,
  getCardEmphasis,
  getConnectorGeometry,
  getConnectorPath,
  getLayoutNavigationKeys,
  getOpenBranchDescendants,
  getVisibleCards,
  groupCardsByDepth
} from "../src/layout";
import { parseCardDocument } from "../src/parser";

const document = parseCardDocument(
  "# Root\n\n## Active branch\n\n### Child\n\n## Sibling\n\n### Sibling child\n\n# Other root\n"
);

describe("groupCardsByDepth", () => {
  it("keeps every card visible in its structural column", () => {
    expect(groupCardsByDepth(document.cards)).toEqual([
      ["card-0", "card-5"],
      ["card-1", "card-3"],
      ["card-2", "card-4"]
    ]);
  });

  it("places a skipped H3 in the logical child column without an empty H2 column", () => {
    const skipped = parseCardDocument("# Root\n\n### Child\n\n##### Grandchild\n");

    expect(groupCardsByDepth(skipped.cards)).toEqual([["card-0"], ["card-1"], ["card-2"]]);
  });
});

describe("getBranchCardIds", () => {
  it("returns every card that can be expanded, including nested branches", () => {
    expect(getBranchCardIds(document.cards)).toEqual(["card-0", "card-1", "card-3"]);
  });
});

describe("getVisibleCards", () => {
  it("hides the complete subtree below a collapsed card", () => {
    const visible = getVisibleCards(document.cards, new Set(["card-1"]));

    expect(visible.map((card) => card.id)).toEqual(["card-0", "card-1", "card-3", "card-4", "card-5"]);
    expect(visible.find((card) => card.id === "card-1")?.children).toEqual([]);
  });

  it("keeps unrelated roots and branches visible", () => {
    const visible = getVisibleCards(document.cards, new Set(["card-0"]));

    expect(visible.map((card) => card.id)).toEqual(["card-0", "card-5"]);
  });

  it("reveals only the direct children when every branch but the selected root is collapsed", () => {
    const deepDocument = parseCardDocument(
      "# Root\n\n## First\n\n### Detail A\n\n#### Deep\n\n### Detail B\n\n## Second\n\n### Detail C\n"
    );
    const collapsed = new Set(getBranchCardIds(deepDocument.cards));
    collapsed.delete("card-0");

    const visible = getVisibleCards(deepDocument.cards, collapsed);

    expect(visible.map((card) => card.id)).toEqual(["card-0", "card-1", "card-5"]);
  });
});

describe("getOpenBranchDescendants", () => {
  it("returns every visible open child branch before its parent branch", () => {
    const deepDocument = parseCardDocument("# Root\n\n## Child\n\n### Grandchild\n\n#### Leaf\n");

    expect(getOpenBranchDescendants(deepDocument.cards, "card-0", new Set())).toEqual(["card-2", "card-1"]);
  });

  it("does not reopen or alter descendants below a branch that was already collapsed", () => {
    expect(getOpenBranchDescendants(document.cards, "card-0", new Set(["card-1"]))).toEqual(["card-3"]);
  });
});

describe("getCardEmphasis", () => {
  const activePath = new Set(["card-0", "card-1"]);

  it("marks the selected card", () => {
    expect(getCardEmphasis(document.cards[1], "card-1", activePath)).toBe("selected");
  });

  it("keeps ancestors as active path", () => {
    expect(getCardEmphasis(document.cards[0], "card-1", activePath)).toBe("active-path");
  });

  it("shows direct children as the next choices", () => {
    expect(getCardEmphasis(document.cards[2], "card-1", activePath)).toBe("next-choice");
  });

  it("deemphasizes siblings and unrelated branches", () => {
    expect(getCardEmphasis(document.cards[3], "card-1", activePath)).toBe("deemphasized");
    expect(getCardEmphasis(document.cards[5], "card-1", activePath)).toBe("deemphasized");
  });
});

describe("computeTreeLayout", () => {
  it("aligns every parent with the top of its first child", () => {
    const heights = new Map(document.cards.map((card) => [card.id, card.id === "card-2" ? 120 : 60]));
    const layout = computeTreeLayout(document.cards, document.roots, heights, 12);

    expect(layout.tops.get("card-0")).toBe(layout.tops.get("card-1"));
    expect(layout.tops.get("card-1")).toBe(layout.tops.get("card-2"));
    expect(layout.tops.get("card-3")).toBe(layout.tops.get("card-4"));
  });

  it("places the next sibling after the complete preceding subtree", () => {
    const heights = new Map(document.cards.map((card) => [card.id, 60]));
    const layout = computeTreeLayout(document.cards, document.roots, heights, 12);
    const activeBranchBottom =
      (layout.tops.get("card-1") ?? 0) + (layout.subtreeHeights.get("card-1") ?? 0);

    expect(layout.tops.get("card-3")).toBe(activeBranchBottom + 12);
    expect(layout.tops.get("card-5")).toBe((layout.subtreeHeights.get("card-0") ?? 0) + 12);
  });

  it("uses a tall parent as the minimum subtree height", () => {
    const heights = new Map(document.cards.map((card) => [card.id, card.id === "card-1" ? 240 : 40]));
    const layout = computeTreeLayout(document.cards, document.roots, heights, 12);

    expect(layout.subtreeHeights.get("card-1")).toBe(240);
  });

  it("moves following siblings up when a preceding branch collapses", () => {
    const heights = new Map(document.cards.map((card) => [card.id, card.id === "card-2" ? 180 : 60]));
    const expanded = computeTreeLayout(document.cards, document.roots, heights, 12);
    const visible = getVisibleCards(document.cards, new Set(["card-1"]));
    const collapsed = computeTreeLayout(visible, document.roots, heights, 12);

    expect(collapsed.tops.get("card-3")).toBeLessThan(expanded.tops.get("card-3") ?? 0);
    expect(collapsed.tops.get("card-3")).toBe(72);
  });
});

describe("orientation-aware layout", () => {
  const dimensions = new Map(
    document.cards.map((card) => [card.id, { width: card.id === "card-2" ? 240 : 100, height: 60 }])
  );

  it("preserves the existing vertical branch stacking in horizontal mode", () => {
    const layout = computeBranchAxisLayout(document.cards, document.roots, dimensions, 12, "horizontal");

    expect(layout.tops.get("card-0")).toBe(layout.tops.get("card-1"));
    expect(layout.subtreeHeights.get("card-0")).toBe(132);
  });

  it("uses card widths to spread sibling branches in vertical mode", () => {
    const layout = computeBranchAxisLayout(document.cards, document.roots, dimensions, 12, "vertical");

    expect(layout.tops.get("card-0")).toBe(layout.tops.get("card-1"));
    expect(layout.subtreeHeights.get("card-1")).toBe(240);
    expect(layout.tops.get("card-3")).toBe(252);
  });

  it("rotates spatial keyboard navigation without changing horizontal mode", () => {
    expect(getLayoutNavigationKeys("horizontal")).toEqual({
      previous: "ArrowUp",
      next: "ArrowDown",
      parent: "ArrowLeft",
      child: "ArrowRight"
    });
    expect(getLayoutNavigationKeys("vertical")).toEqual({
      previous: "ArrowLeft",
      next: "ArrowRight",
      parent: "ArrowUp",
      child: "ArrowDown"
    });
  });
});

describe("first-child connectors", () => {
  const parent = { left: 10, top: 20, width: 100, height: 60 };
  const child = { left: 128, top: 110, width: 120, height: 80 };

  it("points from the right edge of a parent to the left edge of its first child in horizontal mode", () => {
    const geometry = getConnectorGeometry(parent, child, "horizontal");

    expect(geometry).toEqual({ startX: 110, startY: 50, endX: 128, endY: 150 });
    expect(getConnectorPath(geometry, "horizontal")).toBe("M 110 50 C 117 50, 117 150, 124 150");
  });

  it("points from the bottom edge of a parent to the top edge of its first child in vertical mode", () => {
    const geometry = getConnectorGeometry(parent, child, "vertical");

    expect(geometry).toEqual({ startX: 60, startY: 80, endX: 188, endY: 110 });
    expect(getConnectorPath(geometry, "vertical")).toBe("M 60 80 C 60 93, 188 93, 188 106");
  });
});
