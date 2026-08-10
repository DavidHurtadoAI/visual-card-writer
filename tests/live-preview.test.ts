import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { buildEssentialPreviewTokens } from "../src/live-preview";

function stateWithCursor(doc: string, anchor: number): EditorState {
  return EditorState.create({ doc, selection: { anchor }, extensions: [markdown()] });
}

function hiddenText(state: EditorState): string[] {
  return buildEssentialPreviewTokens(state)
    .filter((token) => token.kind === "syntax")
    .map((token) => state.sliceDoc(token.from, token.to));
}

describe("essential live preview decorations", () => {
  const doc = "# Heading\n\n**bold** and *emphasis* and `code` and [label](https://example.com).\n\n[[Target|Alias]]\n";

  it("conceals common Markdown syntax away from the cursor", () => {
    const state = stateWithCursor(doc, doc.length);
    const hidden = hiddenText(state);
    const kinds = buildEssentialPreviewTokens(state).map((token) => token.kind);

    expect(hidden).toContain("#");
    expect(hidden.filter((text) => text === "**")).toHaveLength(2);
    expect(hidden.filter((text) => text === "`")).toHaveLength(2);
    expect(hidden).toContain("https://example.com");
    expect(hidden).toContain("[[");
    expect(hidden).toContain("Target|");
    expect(hidden).toContain("]]" );
    expect(kinds).toEqual(expect.arrayContaining(["heading-1", "strong", "emphasis", "inline-code", "link", "wikilink"]));
  });

  it("reveals the complete construct when the cursor enters it", () => {
    const boldStart = doc.indexOf("**bold**");
    const state = stateWithCursor(doc, boldStart + 3);
    const hidden = buildEssentialPreviewTokens(state)
      .filter((token) => token.kind === "syntax" && token.from >= boldStart && token.to <= boldStart + 8);

    expect(hidden).toEqual([]);
  });

  it("shows a wiki alias while concealing its target and brackets", () => {
    const state = stateWithCursor(doc, 0);
    const wiki = buildEssentialPreviewTokens(state).find((token) => token.kind === "wikilink");

    expect(wiki).toBeDefined();
    expect(state.sliceDoc(wiki?.from, wiki?.to)).toBe("Alias");
  });

  it("does not change the underlying Markdown document", () => {
    const state = stateWithCursor(doc, doc.length);
    buildEssentialPreviewTokens(state);

    expect(state.doc.toString()).toBe(doc);
  });
});
