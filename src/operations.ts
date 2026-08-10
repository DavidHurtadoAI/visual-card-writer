import { parseCardDocument } from "./parser";
import type { CardDocument, CardNode } from "./types";

export type CardInsertionKind = "child" | "sibling";

export interface CardInsertionResult {
  text: string;
  document: CardDocument;
  createdCardId: string;
  insertionOffset: number;
  insertedLength: number;
  previousToNextCardIds: ReadonlyMap<string, string>;
}

const DEFAULT_NEW_CARD_TITLE = "Untitled";

export function insertCard(
  source: string,
  document: CardDocument,
  targetCardId: string,
  kind: CardInsertionKind
): CardInsertionResult {
  if (document.issues.length > 0) {
    throw new Error("Cards cannot be created while the ATX hierarchy has structural errors.");
  }
  const targetIndex = document.cards.findIndex((card) => card.id === targetCardId);
  if (targetIndex === -1) {
    throw new Error(`Card not found: ${targetCardId}.`);
  }
  const target = document.cards[targetIndex];
  if (kind === "child" && target.level >= 6) {
    throw new Error("Markdown supports at most six heading levels; an H6 card cannot have a child.");
  }

  const level = kind === "child" ? target.level + 1 : target.level;
  const insertionOffset = subtreeEndOffset(source, document.cards, targetIndex);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const before = source.slice(0, insertionOffset);
  const after = source.slice(insertionOffset);
  const leadingSeparator = blankLineBefore(before, eol);
  const trailingSeparator = after.length > 0 ? eol + eol : eol;
  const insertion = `${leadingSeparator}${"#".repeat(level)} ${DEFAULT_NEW_CARD_TITLE}${trailingSeparator}`;
  const headingStart = insertionOffset + leadingSeparator.length;
  const text = before + insertion + after;
  const nextDocument = parseCardDocument(text);
  if (nextDocument.issues.length > 0) {
    throw new Error(`Creating the card would invalidate the ATX hierarchy: ${nextDocument.issues[0].message}`);
  }
  const created = nextDocument.cards.find(
    (card) => card.range.start === headingStart && card.level === level && card.title === DEFAULT_NEW_CARD_TITLE
  );
  if (!created) {
    throw new Error("The inserted heading could not be reconciled with the card hierarchy.");
  }

  return {
    text,
    document: nextDocument,
    createdCardId: created.id,
    insertionOffset,
    insertedLength: insertion.length,
    previousToNextCardIds: mapExistingCardIds(document.cards, nextDocument.cards, insertionOffset, insertion.length)
  };
}

function subtreeEndOffset(source: string, cards: CardNode[], targetIndex: number): number {
  const target = cards[targetIndex];
  for (let index = targetIndex + 1; index < cards.length; index += 1) {
    if (cards[index].level <= target.level) {
      return cards[index].range.start;
    }
  }
  return source.length;
}

function blankLineBefore(before: string, eol: string): string {
  if (before.length === 0 || before.endsWith(eol + eol)) {
    return "";
  }
  return before.endsWith("\n") ? eol : eol + eol;
}

function mapExistingCardIds(
  previousCards: CardNode[],
  nextCards: CardNode[],
  insertionOffset: number,
  insertedLength: number
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const previous of previousCards) {
    const expectedStart = previous.range.start >= insertionOffset
      ? previous.range.start + insertedLength
      : previous.range.start;
    const next = nextCards.find(
      (candidate) =>
        candidate.range.start === expectedStart &&
        candidate.level === previous.level &&
        candidate.title === previous.title
    );
    if (!next) {
      throw new Error(`Existing card could not be reconciled after insertion: ${previous.id}.`);
    }
    result.set(previous.id, next.id);
  }
  return result;
}
