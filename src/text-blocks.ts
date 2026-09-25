import { parseCardDocument } from "./parser";
import type { CardDocument, CardNode } from "./types";

/** A visual projection only: whitespace and line endings stay in the source. */
export function parseTextBlockDocument(source: string, selectedHeadings?: ReadonlySet<string>): CardDocument {
  const document = parseCardDocument(source);
  if (document.structure === "slides") return document;
  const cards: CardNode[] = [];
  for (const heading of document.cards) {
    if (selectedHeadings && !selectedHeadings.has(heading.id)) {
      cards.push(heading);
      continue;
    }
    const parent: CardNode = {
      ...heading,
      markdown: source.slice(heading.range.start, heading.range.headingEnd),
      range: { ...heading.range, end: heading.range.headingEnd },
      children: []
    };
    cards.push(parent);
    let start = source.indexOf("\n", heading.range.headingEnd);
    let line = heading.range.line + 1;
    start = start === -1 ? heading.range.end : start + 1;
    let paragraphStart = start;
    let paragraphEnd = start;
    let paragraphLine = line;
    const flushParagraph = (): void => {
      const markdown = source.slice(paragraphStart, paragraphEnd);
      if (!markdown.trim()) return;
      const id = `${heading.id}-line-${paragraphLine - heading.range.line}`;
      parent.children.push(id);
      cards.push({
        id, kind: "paragraph", level: heading.level + 1, depth: heading.depth + 1,
        title: markdown.trim().split(/\r?\n/)[0].slice(0, 80), markdown,
        parentId: heading.id, children: [],
        range: { start: paragraphStart, headingEnd: paragraphStart, end: paragraphEnd, line: paragraphLine }
      });
    };
    while (start < heading.range.end) {
      const newline = source.indexOf("\n", start);
      const end = Math.min(newline === -1 ? source.length : newline, heading.range.end);
      const contentEnd = source[end - 1] === "\r" ? end - 1 : end;
      if (contentEnd === start) {
        flushParagraph();
        paragraphStart = end + 1;
        paragraphEnd = paragraphStart;
        paragraphLine = line + 1;
      } else {
        paragraphEnd = contentEnd;
      }
      start = end + 1;
      line += 1;
    }
    flushParagraph();
    parent.children.push(...heading.children);
  }
  return { ...document, cards };
}

/** Resolve local detail choices conservatively when an external edit shifts headings. */
export function resolveDetailedHeadings(anchors: readonly CardNode[], document: CardDocument): Set<string> {
  const ids = new Set<string>();
  for (const anchor of anchors) {
    const matches = document.cards.filter((card) => card.kind === "heading" && card.title === anchor.title && card.level === anchor.level);
    const match = matches.find((card) => card.range.start === anchor.range.start) ?? (matches.length === 1 ? matches[0] : undefined);
    if (match) ids.add(match.id);
  }
  return ids;
}

/** Only direct text blocks count; nested headings are independent sections. */
export function getExpandableHeadingIds(source: string): Set<string> {
  const counts = new Map<string, number>();
  for (const card of parseTextBlockDocument(source).cards) {
    if (card.kind === "paragraph" && card.parentId) {
      counts.set(card.parentId, (counts.get(card.parentId) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

/** Expanded sections reveal their own blocks; collapsed sections retain their full text. */
export function parseDisclosureDocument(source: string, collapsed: ReadonlySet<string>): CardDocument {
  const selected = getExpandableHeadingIds(source);
  for (const id of collapsed) selected.delete(id);
  return parseTextBlockDocument(source, selected);
}
