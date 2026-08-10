import { describe, expect, it } from "vitest";
import { parseCardDocument, reconcileCard, replaceCardFragment } from "../src/parser";

describe("parseCardDocument", () => {
  it("builds a hierarchy from ATX headings", () => {
    const parsed = parseCardDocument("# Book\nIntro\n\n## Part\nText\n\n### Scene\nAction\n");

    expect(parsed.issues).toEqual([]);
    expect(parsed.cards.map(({ level, title, parentId }) => ({ level, title, parentId }))).toEqual([
      { level: 1, title: "Book", parentId: null },
      { level: 2, title: "Part", parentId: "card-0" },
      { level: 3, title: "Scene", parentId: "card-1" }
    ]);
    expect(parsed.roots).toEqual(["card-0"]);
    expect(parsed.cards[0].children).toEqual(["card-1"]);
  });

  it("keeps each card fragment bounded by the next structural heading", () => {
    const parsed = parseCardDocument("# One\nAlpha\n\n## Two\nBeta\n");

    expect(parsed.cards[0].markdown).toBe("# One\nAlpha\n\n");
    expect(parsed.cards[1].markdown).toBe("## Two\nBeta\n");
  });

  it("supports several H1 roots", () => {
    const parsed = parseCardDocument("# One\n\n## Child\n\n# Two\n");

    expect(parsed.issues).toEqual([]);
    expect(parsed.roots).toEqual(["card-0", "card-2"]);
    expect(parsed.cards[2].parentId).toBeNull();
  });

  it("ignores headings inside fenced code and block quotes", () => {
    const source = "# Root\n\n```md\n## Not a card\n```\n\n> ## Also not a card\n\n## Child\n";
    const parsed = parseCardDocument(source);

    expect(parsed.cards.map((card) => card.title)).toEqual(["Root", "Child"]);
    expect(parsed.cards[0].markdown).toContain("## Not a card");
  });

  it("ignores YAML frontmatter and preserves the prologue", () => {
    const source = "---\ntitle: '# Metadata'\n---\nA preface.\n\n# Root\nBody\n";
    const parsed = parseCardDocument(source);

    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0].title).toBe("Root");
    expect(parsed.prologue).toBe("A preface.\n\n");
  });

  it("accepts closing hashes in an ATX heading", () => {
    const parsed = parseCardDocument("# Title ###\nBody\n");

    expect(parsed.cards[0].title).toBe("Title");
  });

  it("reports when hierarchy does not begin at H1", () => {
    const parsed = parseCardDocument("## Orphan\nBody\n");

    expect(parsed.issues[0]).toMatchObject({ line: 1 });
    expect(parsed.issues[0].message).toContain("start at H1");
  });

  it("reports heading-level jumps", () => {
    const parsed = parseCardDocument("# Root\n\n### Jump\n");

    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].message).toContain("H1 to H3");
  });

  it("does not treat Setext headings as cards", () => {
    const parsed = parseCardDocument("Title\n=====\nText\n");

    expect(parsed.cards).toEqual([]);
    expect(parsed.issues[0].message).toContain("ATX");
  });

  it("tracks exact source offsets with CRLF input", () => {
    const source = "# Root\r\nText\r\n\r\n## Child\r\nMore\r\n";
    const parsed = parseCardDocument(source);

    expect(source.slice(parsed.cards[1].range.start, parsed.cards[1].range.end)).toBe("## Child\r\nMore\r\n");
  });
});

describe("card fragment operations", () => {
  it("replaces only the requested fragment", () => {
    const source = "# Root\nOld\n\n## Child\nKeep\n";
    const parsed = parseCardDocument(source);
    const replaced = replaceCardFragment(source, parsed.cards[0], "# Root\nNew\n\n");

    expect(replaced).toBe("# Root\nNew\n\n## Child\nKeep\n");
  });

  it("rejects an out-of-bounds fragment range", () => {
    const parsed = parseCardDocument("# Root\n");
    parsed.cards[0].range.end = 100;

    expect(() => replaceCardFragment("# Root\n", parsed.cards[0], "# Other\n")).toThrow("Invalid source range");
  });

  it("reconciles an edited card after offsets move", () => {
    const before = parseCardDocument("# Root\nText\n\n## Child\nBody\n");
    const previous = before.cards[1];
    const after = parseCardDocument("# Root\nA much longer text.\n\n## Child\nBody\n");

    expect(reconcileCard(previous, after)?.title).toBe("Child");
  });

  it("falls back to the nearest card when a title changes", () => {
    const before = parseCardDocument("# Root\n\n## Old\n");
    const after = parseCardDocument("# Root\n\n## New\n");

    expect(reconcileCard(before.cards[1], after)?.title).toBe("New");
  });
});
