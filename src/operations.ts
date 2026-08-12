import { hasBlockingIssues, parseCardDocument } from "./parser";
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

export interface HeadingRepairResult {
  text: string;
  document: CardDocument;
  selectedCardId: string;
  previousToNextCardIds: ReadonlyMap<string, string>;
}

const DEFAULT_NEW_CARD_TITLE = "Untitled";

export function insertCard(
  source: string,
  document: CardDocument,
  targetCardId: string,
  kind: CardInsertionKind
): CardInsertionResult {
  if (hasBlockingIssues(document)) {
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
  if (hasBlockingIssues(nextDocument)) {
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

export function promoteCardBranch(
  source: string,
  document: CardDocument,
  targetCardId: string,
  expectedLevel: number
): HeadingRepairResult {
  const targetIndex = document.cards.findIndex((card) => card.id === targetCardId);
  if (targetIndex === -1) {
    throw new Error(`Card not found: ${targetCardId}.`);
  }
  const target = document.cards[targetIndex];
  const delta = expectedLevel - target.level;
  if (delta >= 0) {
    throw new Error(`H${target.level} cannot be promoted to H${expectedLevel}.`);
  }

  const endIndex = subtreeEndIndex(document.cards, targetIndex);
  const affected = document.cards.slice(targetIndex, endIndex);
  for (const card of affected) {
    const nextLevel = card.level + delta;
    if (nextLevel < 1 || nextLevel > 6) {
      throw new Error("Promoting this branch would move a heading outside H1-H6.");
    }
  }

  let text = source;
  for (let index = affected.length - 1; index >= 0; index -= 1) {
    const card = affected[index];
    text = replaceHeadingLevel(text, card, card.level + delta);
  }

  const nextDocument = parseCardDocument(text);
  if (hasBlockingIssues(nextDocument)) {
    throw new Error("Promoting this branch would invalidate the card hierarchy.");
  }
  if (!preservesParentRelationships(document, nextDocument)) {
    throw new Error("Promoting only this branch would change the parent of a following card. Insert the missing parent instead.");
  }
  const repaired = nextDocument.cards[targetIndex];
  if (!repaired || repaired.level !== expectedLevel) {
    throw new Error("The promoted branch could not be reconciled.");
  }

  return {
    text,
    document: nextDocument,
    selectedCardId: repaired.id,
    previousToNextCardIds: mapCardsByOrder(document.cards, nextDocument.cards)
  };
}

export function insertMissingParent(
  source: string,
  document: CardDocument,
  targetCardId: string,
  parentLevel: number
): HeadingRepairResult {
  const targetIndex = document.cards.findIndex((card) => card.id === targetCardId);
  if (targetIndex === -1) {
    throw new Error(`Card not found: ${targetCardId}.`);
  }
  const target = document.cards[targetIndex];
  if (parentLevel < 1 || parentLevel >= target.level) {
    throw new Error(`H${parentLevel} cannot be inserted as a parent of H${target.level}.`);
  }

  const insertionOffset = target.range.start;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const before = source.slice(0, insertionOffset);
  const after = source.slice(insertionOffset);
  const insertion = `${blankLineBefore(before, eol)}${"#".repeat(parentLevel)} ${DEFAULT_NEW_CARD_TITLE}${eol}${eol}`;
  const headingStart = insertionOffset + blankLineBefore(before, eol).length;
  const text = before + insertion + after;
  const nextDocument = parseCardDocument(text);
  if (hasBlockingIssues(nextDocument)) {
    throw new Error("Inserting the missing parent would invalidate the card hierarchy.");
  }
  const created = nextDocument.cards.find(
    (card) => card.range.start === headingStart && card.level === parentLevel && card.title === DEFAULT_NEW_CARD_TITLE
  );
  if (!created) {
    throw new Error("The inserted parent could not be reconciled with the card hierarchy.");
  }

  return {
    text,
    document: nextDocument,
    selectedCardId: created.id,
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

function subtreeEndIndex(cards: CardNode[], targetIndex: number): number {
  const target = cards[targetIndex];
  for (let index = targetIndex + 1; index < cards.length; index += 1) {
    if (cards[index].level <= target.level) {
      return index;
    }
  }
  return cards.length;
}

function replaceHeadingLevel(source: string, card: CardNode, level: number): string {
  const heading = source.slice(card.range.start, card.range.headingEnd);
  const replacement = heading.replace(/^( {0,3})#{1,6}(?=[\t ]|$)/, `$1${"#".repeat(level)}`);
  if (replacement === heading) {
    throw new Error(`Heading not found for ${card.id}.`);
  }
  return source.slice(0, card.range.start) + replacement + source.slice(card.range.headingEnd);
}

function preservesParentRelationships(previous: CardDocument, next: CardDocument): boolean {
  if (previous.cards.length !== next.cards.length) {
    return false;
  }
  const previousIndex = new Map(previous.cards.map((card, index) => [card.id, index]));
  const nextIndex = new Map(next.cards.map((card, index) => [card.id, index]));
  for (let index = 0; index < previous.cards.length; index += 1) {
    const previousParent = previous.cards[index].parentId;
    const nextParent = next.cards[index].parentId;
    const previousParentIndex = previousParent == null ? null : previousIndex.get(previousParent);
    const nextParentIndex = nextParent == null ? null : nextIndex.get(nextParent);
    if (previousParentIndex !== nextParentIndex) {
      return false;
    }
  }
  return true;
}

function mapCardsByOrder(previousCards: CardNode[], nextCards: CardNode[]): ReadonlyMap<string, string> {
  if (previousCards.length !== nextCards.length) {
    throw new Error("Existing cards could not be reconciled after repairing the heading levels.");
  }
  return new Map(previousCards.map((card, index) => [card.id, nextCards[index].id]));
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
