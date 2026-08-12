import { describe, expect, it } from "vitest";
import {
  needsRootHeading,
  parseCardDocument,
  reconcileCard,
  replaceCardFragment,
  withSyntheticRootHeading
} from "../src/parser";

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
    expect(parsed.issues[0]).toMatchObject({
      kind: "level-jump",
      line: 3,
      previousLevel: 1,
      currentLevel: 3,
      expectedLevel: 2
    });
    expect(parsed.issues[0].message).toContain("H1 to H3");
  });

  it("builds a logical tree depth even when Markdown heading levels jump", () => {
    const parsed = parseCardDocument("# Root\n\n### Jump\n\n#### Detail\n");

    expect(parsed.cards.map(({ level, depth, parentId }) => ({ level, depth, parentId }))).toEqual([
      { level: 1, depth: 0, parentId: null },
      { level: 3, depth: 1, parentId: "card-0" },
      { level: 4, depth: 2, parentId: "card-1" }
    ]);
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

  it("parses MARP documents with explicit marp frontmatter as slides", () => {
    const source = "---\nmarp: true\n---\n# One\n\n---\n# Two\n";
    const parsed = parseCardDocument(source);

    expect(parsed.structure).toBe("slides");
    expect(parsed.cards.map(({ kind, title }) => ({ kind, title }))).toEqual([
      { kind: "slide", title: "One" },
      { kind: "slide", title: "Two" }
    ]);
  });

  it("keeps ordinary Markdown thematic breaks in heading mode", () => {
    const source = "# One\nAlpha\n\n---\n\n## Two\nBeta\n";
    const parsed = parseCardDocument(source);

    expect(parsed.structure).toBe("headings");
    expect(parsed.cards.map((card) => card.title)).toEqual(["One", "Two"]);
    expect(parsed.cards[0].markdown).toContain("---");
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

describe("synthetic root heading fallback", () => {
  it("flags a document with no headings as needing a root heading", () => {
    const parsed = parseCardDocument("Just a paragraph, no headings at all.\n");

    expect(needsRootHeading(parsed)).toBe(true);
  });

  it("flags a document that starts below H1 as needing a root heading", () => {
    const parsed = parseCardDocument("## Orphan\nBody\n\n## Sibling\nBody\n");

    expect(needsRootHeading(parsed)).toBe(true);
  });

  it("does not flag a document that already starts at H1", () => {
    const parsed = parseCardDocument("# Root\nBody\n\n## Child\nBody\n");

    expect(needsRootHeading(parsed)).toBe(false);
  });

  it("wraps headingless content under a synthetic H1 with the given title", () => {
    const fixed = withSyntheticRootHeading("Just a paragraph.\n", "My Note");
    const parsed = parseCardDocument(fixed);

    expect(parsed.issues).toEqual([]);
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0]).toMatchObject({ level: 1, title: "My Note" });
    expect(parsed.cards[0].markdown).toContain("Just a paragraph.");
  });

  it("nests pre-existing top-level headings as children of the synthetic H1", () => {
    const fixed = withSyntheticRootHeading("## Alpha\nOne\n\n## Beta\nTwo\n", "My Note");
    const parsed = parseCardDocument(fixed);

    expect(parsed.issues).toEqual([]);
    expect(parsed.cards.map(({ level, title, parentId }) => ({ level, title, parentId }))).toEqual([
      { level: 1, title: "My Note", parentId: null },
      { level: 2, title: "Alpha", parentId: "card-0" },
      { level: 2, title: "Beta", parentId: "card-0" }
    ]);
  });

  it("inserts the synthetic H1 after YAML frontmatter", () => {
    const fixed = withSyntheticRootHeading("---\ntags: [x]\n---\n## Alpha\nBody\n", "My Note");

    expect(fixed.startsWith("---\ntags: [x]\n---\n# My Note\n\n## Alpha")).toBe(true);
    const parsed = parseCardDocument(fixed);
    expect(parsed.issues).toEqual([]);
    expect(parsed.cards[0].title).toBe("My Note");
  });
});
