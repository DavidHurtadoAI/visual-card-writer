import { describe, expect, it, vi } from "vitest";
import { VisualCardWriterView } from "../src/view";
import { parseCardDocument } from "../src/parser";
import { getExpandableHeadingIds, parseDisclosureDocument } from "../src/text-blocks";
import { getVisibleCards } from "../src/layout";
import type { CardDocument } from "../src/types";

vi.mock("obsidian", () => ({ TextFileView: class {} }));

interface ViewHarness {
  data: string;
  parsed: CardDocument;
  collapsedCardIds: Set<string>;
  expandableHeadingIds: Set<string>;
  editor: null;
  scheduleBlockButtonUpdate: () => void;
  cancelViewportScrollAnimation: () => void;
  renderView: () => Promise<void>;
}

describe("disclosure view refresh", () => {
  it("allows heading drags with H6 text blocks without treating blocks as H7 headings", () => {
    const source = "# Root\n## A\n### B\n#### C\n##### D\n###### First\nOne\n\nTwo\n###### Last\nTarget";
    const view = Object.assign(Object.create(VisualCardWriterView.prototype) as {
      canDropCard(sourceId: string, targetId: string, placement: string): boolean;
    }, { parsed: parseDisclosureDocument(source, new Set()), sessionConflict: false });
    expect(view.canDropCard("card-5", "card-6", "after")).toBe(true);
    expect(view.canDropCard("card-5", "card-6", "child")).toBe(false);
    expect(view.canDropCard("card-5-line-1", "card-6", "child")).toBe(true);
    expect(view.canDropCard("card-5", "card-5-line-1", "after")).toBe(false);
  });

  it.each(["", "\n### Child\nChild text"])("selects a collapsed card without expanding its blocks or headings (%j)", async (child) => {
    const source = `# Root\n## Section\nFirst\n\nSecond${child}`;
    const parsed = parseCardDocument(source);
    const collapsed = new Set(["card-1"]);
    const view = Object.assign(Object.create(VisualCardWriterView.prototype) as {
      selectCard(id: string): Promise<void>;
      selectedCardId: string | null;
    }, {
      data: source, parsed, collapsedCardIds: collapsed,
      editor: null, selectedCardId: null,
      cancelViewportScrollAnimation: vi.fn(), cancelCardTransition: vi.fn(),
      updateSelectionPresentation: vi.fn(), cardElement: () => null,
      animateViewportToCard: vi.fn(), renderView: vi.fn()
    });
    await view.selectCard("card-1");
    expect(view.selectedCardId).toBe("card-1");
    expect([...collapsed]).toEqual(["card-1"]);
    expect(view.parsed).toBe(parsed);
    expect(view.renderView).not.toHaveBeenCalled();
    expect(view.updateSelectionPresentation).toHaveBeenCalledOnce();
  });

  it("rebuilds the card fragments on every open, close and reopen before laying out the DOM", async () => {
    const source = "# Root\n## Principles\n1. First\n2. Second\n\n\nThis should be another block\n";
    const view = Object.create(VisualCardWriterView.prototype) as ViewHarness;
    const beforeLayout = new Error("Stop before DOM layout");
    Object.assign(view, {
      data: source,
      parsed: parseCardDocument(source),
      collapsedCardIds: new Set(["card-1"]),
      expandableHeadingIds: getExpandableHeadingIds(source),
      editor: null,
      scheduleBlockButtonUpdate: vi.fn(),
      cancelViewportScrollAnimation: () => { throw beforeLayout; }
    });
    for (const expanded of [true, false, true]) {
      if (expanded) view.collapsedCardIds.delete("card-1");
      else view.collapsedCardIds.add("card-1");
      await expect(view.renderView()).rejects.toBe(beforeLayout);
      const visible = getVisibleCards(view.parsed.cards, view.collapsedCardIds);
      expect(visible.filter((card) => card.kind === "paragraph").map((card) => card.markdown)).toEqual(
        expanded ? ["1. First\n2. Second", "This should be another block"] : []
      );
      expect(view.parsed.cards.find((card) => card.id === "card-1")?.markdown).toBe(
        expanded ? "## Principles" : source.slice(source.indexOf("## Principles"))
      );
      expect(view.data).toBe(source);
    }
  });
});
