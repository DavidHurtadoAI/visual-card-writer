import { describe, expect, it } from "vitest";
import { getExpandableHeadingIds, parseDisclosureDocument, parseTextBlockDocument, resolveDetailedHeadings } from "../src/text-blocks";
import { parseCardDocument, replaceCardFragment } from "../src/parser";
import { getBranchCardIds, getVisibleCards } from "../src/layout";

describe("section text blocks", () => {
  it("uses one disclosure state for section text and nested headings", () => {
    const source = "# Root\nIntro\n\nMore\n## Child\nFirst\n\nSecond\n";
    const closed = new Set(["card-0", "card-1"]);
    let document = parseDisclosureDocument(source, closed);
    expect(document).toEqual(parseCardDocument(source));
    expect(getVisibleCards(document.cards, closed).map((card) => card.markdown)).toEqual(["# Root\nIntro\n\nMore\n"]);
    closed.delete("card-0");
    document = parseDisclosureDocument(source, closed);
    expect(getVisibleCards(document.cards, closed).map((card) => card.markdown)).toEqual(["# Root", "Intro", "More", "## Child\nFirst\n\nSecond\n"]);
    closed.clear();
    document = parseDisclosureDocument(source, closed);
    expect(document.cards.filter((card) => card.kind === "paragraph")).toHaveLength(4);
    expect(parseDisclosureDocument(source, new Set(["card-0", "card-1"]))).toEqual(parseCardDocument(source));
  });

  it("keeps zero or one block inline even when a section has subheadings", () => {
    const source = "# Root\nOne block\n## Empty\n### Child\nFirst\n\nSecond";
    const document = parseDisclosureDocument(source, new Set());
    expect(document.cards[0].markdown).toBe("# Root\nOne block\n");
    expect(document.cards[1].markdown).toBe("## Empty\n");
    expect(document.cards.filter((card) => card.kind === "paragraph")).toHaveLength(2);
  });

  it("regroups an open section after edits reduce it to one block", () => {
    const source = "# Root\nOne\n\nTwo";
    expect(parseDisclosureDocument(source, new Set()).cards).toHaveLength(3);
    expect(parseDisclosureDocument(source.replace("\n\n", "\n"), new Set()).cards).toHaveLength(1);
    expect(parseDisclosureDocument(source, new Set(["card-0"]))).toEqual(parseCardDocument(source));
  });

  it("offers expansion only for two or more direct blocks, ignoring nested sections", () => {
    const source = "# Empty\n## Single\nFirst\ncontinuation\n### Multiple\nOne\n\nTwo\n## Whitespace\n\n  \n\n";
    expect([...getExpandableHeadingIds(source)]).toEqual(["card-2"]);
  });

  it("updates eligibility when edits add, join, or remove blocks", () => {
    const drafts = ["# Root\nOne", "# Root\nOne\n\n", "# Root\nOne\n\nTwo", "# Root\nOne\nTwo", "# Root\n"];
    expect(drafts.map((draft) => getExpandableHeadingIds(draft).has("card-0"))).toEqual([false, false, true, false, false]);
    expect(getExpandableHeadingIds("# Root\nIntro\n- One\n- Two").size).toBe(0);
    expect(getExpandableHeadingIds("# Root\nIntro\n\n- One\n- Two").size).toBe(1);
  });

  it.each(["\n", "\r\n"])("groups tables, nested lists and callouts using empty lines (%j)", (eol) => {
    const blocks = [
      "Benefits:\n- Fast\n  - Nested detail\n- Easy",
      "Steps:\n1. Start\n   Continuation\n2. Finish",
      "| Name | Value |\n| --- | --- |\n| A | 1 |",
      "> [!note] Important\n> Callout text\n>\n> Another paragraph inside the callout",
      "Final paragraph\nwith a manually wrapped line"
    ].map((block) => block.split("\n").join(eol));
    const source = `# Root${eol}${eol}${blocks.join(eol + eol)}${eol}${eol}${eol}## End${eol}`;
    for (const selected of [undefined, new Set(["card-0"])]) {
      const document = parseTextBlockDocument(source, selected);
      const paragraphs = document.cards.filter((card) => card.kind === "paragraph");
      expect(paragraphs.map((card) => card.markdown)).toEqual(blocks);
      for (const card of paragraphs) {
        expect(source.slice(card.range.start, card.range.end)).toBe(card.markdown);
        expect(card.range.line).toBe(source.slice(0, card.range.start).split("\n").length);
        expect(replaceCardFragment(source, card, "Replacement")).toBe(source.slice(0, card.range.start) + "Replacement" + source.slice(card.range.end));
      }
    }
  });

  it("requires a completely empty line and preserves whitespace-only lines within a paragraph", () => {
    const document = parseTextBlockDocument("# Root\nFirst\n  \nSecond\n\n\nThird");
    expect(document.cards.filter((card) => card.kind === "paragraph").map((card) => card.markdown)).toEqual(["First\n  \nSecond", "Third"]);
  });

  it("splits on an empty line even inside a structured block, following the literal rule", () => {
    const document = parseTextBlockDocument("# Root\n- One\n\n- Two\n");
    expect(document.cards.filter((card) => card.kind === "paragraph").map((card) => card.markdown)).toEqual(["- One", "- Two"]);
  });

  it("expands just one section and preserves the other sections and nested headings", () => {
    const source = "# Campaign\nOverview\n## Benefits\nFast\n\nEasy\n### Evidence\nSurvey\n## Audience\nTeams\n";
    const normal = parseCardDocument(source);
    const mixed = parseTextBlockDocument(source, new Set(["card-1"]));
    expect(mixed.cards.map((card) => card.markdown)).toEqual([
      "# Campaign\nOverview\n", "## Benefits", "Fast", "Easy", "### Evidence\nSurvey\n", "## Audience\nTeams\n"
    ]);
    expect(mixed.cards.find((card) => card.id === "card-1")?.children).toEqual(["card-1-line-1", "card-1-line-3", "card-2"]);
    expect(parseTextBlockDocument(source, new Set())).toEqual(normal);
    const edited = replaceCardFragment(source, mixed.cards[2], "Very fast");
    expect(parseCardDocument(edited).cards[1].markdown).toBe("## Benefits\nVery fast\n\nEasy\n");
  });

  it("allows independent detail in several sections", () => {
    const document = parseTextBlockDocument("# Root\nIntro\n## A\nFirst\n## B\nSecond\n", new Set(["card-1", "card-2"]));
    expect(document.cards.filter((card) => card.kind === "paragraph").map((card) => card.title)).toEqual(["First", "Second"]);
    expect(document.cards[0].markdown).toBe("# Root\nIntro\n");
  });

  it("tracks a section across preceding insertions and drops removed or ambiguous choices", () => {
    const original = parseCardDocument("# Root\n## Benefits\nText\n");
    const anchors = [original.cards[1]];
    expect([...resolveDetailedHeadings(anchors, parseCardDocument("# Root\n## New\nNew text\n## Benefits\nText\n"))]).toEqual(["card-2"]);
    expect(resolveDetailedHeadings(anchors, parseCardDocument("# Root\n## Other\nText\n")).size).toBe(0);
    expect(resolveDetailedHeadings(anchors, parseCardDocument("# Root\nLong intro\n## Benefits\nOne\n## Benefits\nTwo\n")).size).toBe(0);
  });

  it("keeps consecutive lines together and nests paragraphs under the nearest heading", () => {
    const source = "# Book\nIntro\nSecond line\n\n## Part\nDetail\n### Scene\nAction\n# End\nBye";
    const document = parseTextBlockDocument(source);
    expect(document.cards.map((card) => card.markdown)).toEqual([
      "# Book", "Intro\nSecond line", "## Part", "Detail", "### Scene", "Action", "# End", "Bye"
    ]);
    for (const card of document.cards) {
      expect(source.slice(card.range.start, card.range.end)).toBe(card.markdown);
      if (card.parentId) expect(document.cards.find((parent) => parent.id === card.parentId)?.children).toContain(card.id);
    }
    const collapsed = new Set(getBranchCardIds(document.cards));
    expect(getVisibleCards(document.cards, collapsed).map((card) => card.title)).toEqual(["Book", "End"]);
    collapsed.delete(document.roots[0]);
    expect(getVisibleCards(document.cards, collapsed).map((card) => card.title)).toEqual(["Book", "Intro", "Part", "End"]);
  });

  it("preserves CRLF, frontmatter, blank lines and neighboring content on edit", () => {
    const source = "---\r\ntags: test\r\n---\r\n# Root\r\n\r\nFirst\r\nSecond\r\n\r\n## Child\r\nLast\r\n";
    const document = parseTextBlockDocument(source);
    const first = document.cards.find((card) => card.title === "First")!;
    expect(first.range.line).toBe(6);
    expect(replaceCardFragment(source, first, "Updated\r\nSecond")).toBe(source.replace("First", "Updated"));
    expect(replaceCardFragment(source, document.cards[0], "# Renamed")).toBe(source.replace("# Root", "# Renamed"));
    expect(parseCardDocument(source).cards[0].markdown).toContain("First\r\nSecond");
  });

  it("keeps consecutive code and quoted lines in one card, not structural headings", () => {
    const document = parseTextBlockDocument("# Root\n```md\n## Code\n```\n> ## Quote\n- Item\n");
    expect(document.cards.filter((card) => card.kind === "heading")).toHaveLength(1);
    expect(document.cards.filter((card) => card.kind === "paragraph")).toHaveLength(1);
  });

  it("supports H6 content and empty headings without artificial headings", () => {
    const source = "# Root\n## Empty\n###### Deep\nText";
    const document = parseTextBlockDocument(source);
    expect(document.cards[document.cards.length - 1]?.level).toBe(7);
    expect(document.cards[document.cards.length - 1]?.kind).toBe("paragraph");
    expect(document.cards.find((card) => card.title === "Empty")?.markdown).toBe("## Empty");
  });

  it("leaves slide mode unchanged", () => {
    const source = "---\nmarp: true\n---\n# One\nText\n---\n# Two\nMore\n";
    expect(parseTextBlockDocument(source)).toEqual(parseCardDocument(source));
  });
});
