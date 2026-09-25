import { moveCard } from "./operations";
import type { CardMovePlacement, CardMoveResult } from "./operations";
import { hasBlockingIssues, parseCardDocument } from "./parser";
import { parseTextBlockDocument } from "./text-blocks";
import type { CardNode } from "./types";

/** Work against the complete source, never the shortened heading shown in an open card. */
export function moveVisibleCard(source: string, sourceId: string, targetId: string, placement: CardMovePlacement): CardMoveResult {
  const headings = parseCardDocument(source);
  const full = parseTextBlockDocument(source);
  const moving = full.cards.find((card) => card.id === sourceId);
  const target = full.cards.find((card) => card.id === targetId);
  if (!moving || !target || sourceId === targetId || hasBlockingIssues(headings)) {
    throw new Error("Invalid card move.");
  }
  if (moving.kind !== "paragraph") {
    if (target.kind === "paragraph") throw new Error("Drop headings on other headings, not on text blocks.");
    const result = moveCard(source, headings, sourceId, targetId, placement);
    const document = parseTextBlockDocument(result.text);
    const mapping = new Map(result.previousToNextCardIds);
    for (const heading of headings.cards) {
      const oldBlocks = full.cards.filter((card) => card.kind === "paragraph" && card.parentId === heading.id);
      const newBlocks = document.cards.filter((card) => card.kind === "paragraph" && card.parentId === mapping.get(heading.id));
      if (oldBlocks.length !== newBlocks.length) throw new Error("Moving the heading would change its text blocks.");
      oldBlocks.forEach((card, index) => {
        if (card.markdown !== newBlocks[index].markdown) throw new Error("Moving the heading would change a text block.");
        mapping.set(card.id, newBlocks[index].id);
      });
    }
    return { ...result, document, previousToNextCardIds: mapping };
  }
  if (target.kind === "slide" || (target.kind === "paragraph" && placement === "child") || (target.kind === "heading" && placement !== "child")) {
    throw new Error("Drop text blocks before or after another block, or inside a heading.");
  }
  const insertion = target.kind === "heading"
    ? headings.cards.find((card) => card.id === targetId)!.range.end
    : placement === "before" ? target.range.start : target.range.end;
  const removedLength = moving.range.end - moving.range.start;
  const without = source.slice(0, moving.range.start) + source.slice(moving.range.end);
  const offset = insertion >= moving.range.end ? insertion - removedLength : insertion;
  const before = without.slice(0, offset);
  const after = without.slice(offset);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const leading = before.length === 0 || before.endsWith(eol + eol) ? "" : before.endsWith(eol) ? eol : eol + eol;
  const trailing = after.length === 0 || after.startsWith(eol + eol) ? "" : after.startsWith(eol) ? eol : eol + eol;
  const inserted = leading + moving.markdown + trailing;
  const text = before + inserted + after;
  const document = parseTextBlockDocument(text);
  if (hasBlockingIssues(document) || document.cards.length !== full.cards.length) {
    throw new Error("This move would change the Markdown structure.");
  }
  const mapping = new Map<string, string>();
  for (const card of full.cards) {
    let start = card.range.start;
    if (card.id === sourceId) start = offset + leading.length;
    else {
      if (start >= moving.range.end) start -= removedLength;
      if (start >= offset) start += inserted.length;
    }
    const next = document.cards.find((candidate) => candidate.range.start === start && candidate.kind === card.kind);
    if (!next || !sameContent(card, next)) throw new Error("This move would change another card's content.");
    mapping.set(card.id, next.id);
  }
  const movedCardId = mapping.get(sourceId)!;
  const moved = document.cards.find((card) => card.id === movedCardId)!;
  const expectedParent = target.kind === "heading" ? target.id : target.parentId!;
  if (moved.parentId !== mapping.get(expectedParent)) throw new Error("The block did not land in the intended section.");
  return { text, document, movedCardId, previousToNextCardIds: mapping };
}

function sameContent(previous: CardNode, next: CardNode): boolean {
  return previous.kind === "paragraph"
    ? previous.markdown === next.markdown
    : previous.title === next.title && previous.level === next.level;
}
