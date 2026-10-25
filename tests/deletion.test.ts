import { describe, expect, it } from "vitest";
import { deleteCard, insertCard, moveCard } from "../src/operations";
import { parseCardDocument } from "../src/parser";
import { DeletionHistory } from "../src/deletion-history";

describe("card deletion", () => {
  const source = "---\ntitle: Keep\n---\nPreface\n\n## A\nA body\n\n### B\nB body\n\n#### C\n```md\n##### code\n```\n\n### D\nD body\n\n## E\nE body\n";
  it("removes a complete subtree and remaps duplicate titles by position", () => {
    const before = parseCardDocument(source);
    const result = deleteCard(source, before, "card-1");
    expect(result.text).toBe(source.slice(0, before.cards[1].range.start) + source.slice(before.cards[3].range.start));
    expect(result.document.cards.map(card => card.title)).toEqual(["A", "D", "E"]);
    expect(result.selectedCardId).toBe("card-0");
    expect(result.previousToNextCardIds.get("card-3")).toBe("card-1");
  });
  it("keeps children and promotes only structural markers, preserving frontmatter, prologue and code", () => {
    const result = deleteCard(source, parseCardDocument(source), "card-1", true);
    expect(result.document.cards.map(card => [card.title,card.level])).toEqual([["A",2],["C",3],["D",3],["E",2]]);
    expect(result.text).toContain("##### code");
    expect(result.text.startsWith("---\ntitle: Keep\n---\nPreface\n\n")).toBe(true);
    expect(result.text).not.toContain("B body");
  });
  it("selects the previous sibling, or parent, or next remaining root", () => {
    const before=parseCardDocument(source);
    expect(deleteCard(source,before,"card-3").selectedCardId).toBe("card-1");
    expect(deleteCard(source,before,"card-0").document.cards[0].title).toBe("E");
    expect(deleteCard(source,before,"card-0").selectedCardId).toBe("card-0");
  });
  it("can delete the final card without inventing a heading or deleting metadata", () => {
    const text="---\ntags: test\n---\nPreface\n\n###### Last\nBody\n";
    const result=deleteCard(text,parseCardDocument(text),"card-0");
    expect(result.text).toBe("---\ntags: test\n---\nPreface\n\n");
    expect(result.document.cards).toEqual([]);
    expect(result.selectedCardId).toBeNull();
  });
  it("preserves CRLF and duplicate heading identity", () => {
    const text="## Same\r\nA\r\n\r\n## Same\r\nB\r\n\r\n## Same\r\nC\r\n";
    const before=parseCardDocument(text);
    const result=deleteCard(text,before,"card-1");
    expect(result.text).toBe(before.cards[0].markdown+before.cards[2].markdown);
    expect([...result.previousToNextCardIds]).toEqual([["card-0","card-0"],["card-2","card-1"]]);
  });
  it("preserves surrounding Marp slide separators when deleting first, middle or last", () => {
    const text="---\nmarp: true\n---\n# A\n\n---\n# B\n\n---\n# C\n";
    for (let index=0;index<3;index++) {
      const result=deleteCard(text,parseCardDocument(text),`card-${index}`);
      expect(result.document.cards.map(card=>card.title)).toEqual(["A","B","C"].filter((_,i)=>i!==index));
      expect(result.text.startsWith("---\nmarp: true\n---\n")).toBe(true);
    }
  });
  it("supports insertion and moves in forests beginning at H2 through H6", () => {
    for(let level=2;level<=6;level++) {
      const text=`${"#".repeat(level)} A\n\n${"#".repeat(level)} B\n`;
      const doc=parseCardDocument(text);
      expect(insertCard(text,doc,"card-0","sibling").document.roots).toHaveLength(3);
      expect(moveCard(text,doc,"card-1","card-0","before").document.cards.map(card=>card.title)).toEqual(["B","A"]);
    }
  });
});

describe("conditional deletion history", () => {
  it("undoes and redoes multiple deletions exactly and keeps their selections", () => {
    const history=new DeletionHistory();
    history.record({before:"ABC",after:"AB",selectedBefore:"C",selectedAfter:"B"});
    history.record({before:"AB",after:"A",selectedBefore:"B",selectedAfter:"A"});
    expect(history.undo("A")).toEqual({text:"AB",selectedCardId:"B"});
    expect(history.undo("AB")).toEqual({text:"ABC",selectedCardId:"C"});
    expect(history.redo("ABC")).toEqual({text:"AB",selectedCardId:"B"});
    expect(history.redo("AB")).toEqual({text:"A",selectedCardId:"A"});
  });
  it("never replaces subsequent edits and discards redo after another deletion", () => {
    const history=new DeletionHistory();
    history.record({before:"AB",after:"A",selectedBefore:null,selectedAfter:null});
    expect(history.undo("External changes")).toBeNull();
    history.undo("A");
    history.record({before:"AB",after:"B",selectedBefore:null,selectedAfter:null});
    expect(history.redo("AB")).toBeNull();
    history.clear();
    expect(history.undo("B")).toBeNull();
  });
});
