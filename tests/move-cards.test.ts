import { describe, expect, it } from "vitest";
import { moveVisibleCard } from "../src/move-cards";
import { parseTextBlockDocument } from "../src/text-blocks";
import { parseCardDocument } from "../src/parser";

function blocks(text: string) {
  return parseTextBlockDocument(text).cards.filter((card) => card.kind === "paragraph");
}

describe("moving headings and text blocks", () => {
  it.each(["\n", "\r\n"])("reorders a block in both directions without changing its contents (%j)", (eol) => {
    const source = ["# Root", "", "First", "", "Second", "", "Third"].join(eol);
    const original = blocks(source);
    const down = moveVisibleCard(source, original[0].id, original[2].id, "after");
    expect(blocks(down.text).map((card) => card.markdown)).toEqual(["Second", "Third", "First"]);
    const reordered = blocks(down.text);
    const up = moveVisibleCard(down.text, reordered[2].id, reordered[0].id, "before");
    expect(blocks(up.text).map((card) => card.markdown)).toEqual(["First", "Second", "Third"]);
    expect([...up.previousToNextCardIds.values()]).toHaveLength(4);
  });

  it("moves a complete list into a heading before its nested subsections", () => {
    const source = "---\ntags: demo\n---\n# Root\n## Source\nIntro\n\nBenefits:\n- A\n  - Nested\n- B\n\n## Destination\nExisting\n### Child\nKeep this\n";
    const list = blocks(source).find((card) => card.markdown.startsWith("Benefits"))!;
    const destination = parseCardDocument(source).cards.find((card) => card.title === "Destination")!;
    const result = moveVisibleCard(source, list.id, destination.id, "child");
    expect(result.text.startsWith("---\ntags: demo\n---\n")).toBe(true);
    expect(blocks(result.text).map((card) => card.markdown)).toEqual(["Intro", "Existing", list.markdown, "Keep this"]);
    const moved = result.document.cards.find((card) => card.id === result.movedCardId)!;
    expect(moved.parentId).toBe(result.previousToNextCardIds.get(destination.id));
    expect(parseCardDocument(result.text).cards.find((card) => card.title === "Child")?.markdown).toBe("### Child\nKeep this\n");
  });

  it("can move the last source block into an empty heading", () => {
    const source = "# Root\n## From\nOnly block\n## Empty";
    const result = moveVisibleCard(source, blocks(source)[0].id, "card-2", "child");
    expect(blocks(result.text).map((card) => [card.markdown, card.parentId])).toEqual([["Only block", "card-2"]]);
  });

  it("keeps tables, callouts and identical text blocks distinct when moving between sections", () => {
    const source = "# Root\n## A\nSame\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n## B\nSame\n\n> [!note]\n> Body\n>\n> Next";
    const original = blocks(source);
    const result = moveVisibleCard(source, original[1].id, original[2].id, "before");
    expect(blocks(result.text).map((card) => card.markdown)).toEqual([original[0].markdown, original[1].markdown, original[2].markdown, original[3].markdown]);
    expect(new Set(result.previousToNextCardIds.values()).size).toBe(result.document.cards.length);
    expect(result.document.cards.find((card) => card.id === result.movedCardId)?.parentId).toBe("card-2");
  });

  it("moves an entire heading branch including all expanded blocks", () => {
    const source = "# Root\n## A\nFirst\n\nSecond\n### Child\nDeep\n\nMore\n## B\nTarget\n";
    const result = moveVisibleCard(source, "card-1", "card-3", "child");
    expect(parseCardDocument(result.text).cards.map((card) => [card.title, card.level])).toEqual([["Root", 1], ["B", 2], ["A", 3], ["Child", 4]]);
    expect(blocks(result.text).map((card) => card.markdown)).toEqual(["Target", "First", "Second", "Deep", "More"]);
    expect(result.previousToNextCardIds.size).toBe(parseTextBlockDocument(source).cards.length);
  });

  it("rejects unsupported nesting and heading drops on blocks", () => {
    const source = "# Root\nFirst\n\nSecond\n## Child\nText";
    const [first, second] = blocks(source);
    expect(() => moveVisibleCard(source, first.id, second.id, "child")).toThrow();
    expect(() => moveVisibleCard(source, "card-1", first.id, "before")).toThrow();
    expect(() => moveVisibleCard(source, first.id, "card-1", "before")).toThrow();
    expect(() => moveVisibleCard(source, "card-0", "card-1", "child")).toThrow();
  });
});
