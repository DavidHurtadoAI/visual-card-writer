import { describe, expect, it } from "vitest";
import { insertCard } from "../src/operations";
import { parseCardDocument } from "../src/parser";

describe("card insertion operations", () => {
  it("appends a child after the target's complete existing subtree", () => {
    const source = "# Root\n\n## First\n\n### Grandchild\n\n# Other root\n";
    const before = parseCardDocument(source);
    const result = insertCard(source, before, "card-0", "child");

    expect(result.text).toBe(
      "# Root\n\n## First\n\n### Grandchild\n\n## Untitled\n\n# Other root\n"
    );
    const created = result.document.cards.find((card) => card.id === result.createdCardId);
    expect(created).toMatchObject({ level: 2, title: "Untitled", parentId: "card-0" });
  });

  it("creates a sibling below the target's complete subtree", () => {
    const source = "# Root\n\n## Branch\n\n### Child\n\n## Following\n";
    const before = parseCardDocument(source);
    const result = insertCard(source, before, "card-1", "sibling");

    expect(result.text).toBe(
      "# Root\n\n## Branch\n\n### Child\n\n## Untitled\n\n## Following\n"
    );
    const created = result.document.cards.find((card) => card.id === result.createdCardId);
    expect(created).toMatchObject({ level: 2, title: "Untitled", parentId: "card-0" });
  });

  it("preserves CRLF and remaps cards shifted by the insertion", () => {
    const source = "# Root\r\n\r\n## Existing\r\n\r\n# Later\r\n";
    const before = parseCardDocument(source);
    const result = insertCard(source, before, "card-0", "child");

    expect(result.text).toContain("## Untitled\r\n\r\n# Later");
    expect(result.text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(result.previousToNextCardIds.get("card-2")).toBe("card-3");
    expect(result.document.cards[3].title).toBe("Later");
  });

  it("rejects children below H6 without changing the source", () => {
    const source = "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n";
    const before = parseCardDocument(source);

    expect(() => insertCard(source, before, "card-5", "child")).toThrow("at most six");
    expect(source).toBe("# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n");
  });

  it("rejects insertion into an invalid hierarchy", () => {
    const source = "# Root\n\n### Jump\n";
    const before = parseCardDocument(source);

    expect(() => insertCard(source, before, "card-0", "child")).toThrow("structural errors");
  });
});
