import { fromMarkdown } from "mdast-util-from-markdown";
import type { CardDocument, CardNode, ParseIssue } from "./types";

type MarkdownRoot = ReturnType<typeof fromMarkdown>;
type Heading = Extract<MarkdownRoot["children"][number], { type: "heading" }>;

interface StructuralHeading {
  start: number;
  end: number;
  line: number;
  level: number;
  title: string;
}

interface FrontmatterRange {
  end: number;
  marp: boolean;
}

const ATX_PATTERN = /^ {0,3}(#{1,6})(?:[\t ]+|$)/;
const SLIDE_SEPARATOR_PATTERN = /^ {0,3}---[\t ]*$/;

export function parseCardDocument(source: string): CardDocument {
  const frontmatter = findFrontmatter(source);
  const contentStart = frontmatter?.end ?? 0;
  const slideSeparators = frontmatter?.marp ? findSlideSeparators(source, contentStart) : [];
  if (slideSeparators.length > 0) {
    return parseSlideDocument(source, contentStart, slideSeparators);
  }
  const parseSource = frontmatter ? maskFrontmatter(source, frontmatter.end) : source;
  const tree = fromMarkdown(parseSource);
  const headings = tree.children
    .filter((node): node is Heading => node.type === "heading" && node.position != null)
    .map((node) => toStructuralHeading(source, node))
    .filter((heading): heading is StructuralHeading => heading != null);

  if (headings.length === 0) {
    return {
      structure: "headings",
      cards: [],
      roots: [],
      issues: [{ kind: "no-headings", line: 1, message: "The note does not contain a structural ATX heading." }],
      prologue: source.slice(frontmatter?.end ?? 0)
    };
  }

  const issues = validateHierarchy(headings);
  const cards: CardNode[] = [];
  const roots: string[] = [];
  const stack: CardNode[] = [];

  headings.forEach((heading, index) => {
    const end = headings[index + 1]?.start ?? source.length;
    const id = `card-${index}`;
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    const parent = heading.level > 1 ? stack[stack.length - 1] ?? null : null;
    const card: CardNode = {
      id,
      kind: "heading",
      level: heading.level,
      depth: parent ? parent.depth + 1 : 0,
      title: heading.title,
      markdown: source.slice(heading.start, end),
      parentId: parent?.id ?? null,
      children: [],
      range: { start: heading.start, headingEnd: heading.end, end, line: heading.line }
    };
    cards.push(card);
    if (parent) {
      parent.children.push(id);
    } else {
      roots.push(id);
    }
    stack.push(card);
  });
  return { structure: "headings", cards, roots, issues, prologue: source.slice(contentStart, headings[0].start) };
}

export function needsRootHeading(document: CardDocument): boolean {
  return document.structure === "headings" && (document.cards.length === 0 || document.cards[0].level !== 1);
}

export function hasBlockingIssues(document: CardDocument): boolean {
  return document.issues.some((issue) => issue.kind !== "level-jump");
}

export function withSyntheticRootHeading(source: string, title: string): string {
  const frontmatter = findFrontmatter(source);
  const insertAt = frontmatter?.end ?? 0;
  return `${source.slice(0, insertAt)}# ${title}\n\n${source.slice(insertAt)}`;
}

export function replaceCardFragment(source: string, card: CardNode, replacement: string): string {
  if (card.range.start < 0 || card.range.end < card.range.start || card.range.end > source.length) {
    throw new Error(`Invalid source range for ${card.id}.`);
  }
  return source.slice(0, card.range.start) + replacement + source.slice(card.range.end);
}

export function reconcileCard(previous: CardNode, next: CardDocument): CardNode | null {
  const exact = next.cards.find(
    (card) => card.range.start === previous.range.start && card.level === previous.level && card.title === previous.title
  );
  if (exact) {
    return exact;
  }
  const contextual = next.cards.filter((card) => card.level === previous.level && card.title === previous.title);
  if (contextual.length === 1) {
    return contextual[0];
  }
  return (
    [...next.cards].sort(
      (left, right) => Math.abs(left.range.start - previous.range.start) - Math.abs(right.range.start - previous.range.start)
    )[0] ?? null
  );
}

function parseSlideDocument(source: string, contentStart: number, separators: number[]): CardDocument {
  const cards: CardNode[] = [];
  const roots: string[] = [];
  const starts = [contentStart, ...separators.map((start) => lineEndOffset(source, start))];
  const ends = [...separators, source.length];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = ends[index];
    const markdown = source.slice(start, end);
    const id = `card-${index}`;
    cards.push({
      id,
      kind: "slide",
      level: 1,
      depth: 0,
      title: slideTitle(markdown, index + 1),
      markdown,
      parentId: null,
      children: [],
      range: { start, headingEnd: start, end, line: lineNumberAtOffset(source, start) }
    });
    roots.push(id);
  }
  return {
    structure: "slides",
    cards,
    roots,
    issues: [],
    prologue: source.slice(contentStart, starts[0] ?? contentStart)
  };
}

function findSlideSeparators(source: string, startOffset: number): number[] {
  const separators: number[] = [];
  let cursor = startOffset;
  let fencedCodeMarker: string | null = null;
  while (cursor <= source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const rawLine = source.slice(cursor, end).replace(/\r$/, "");
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(rawLine);
    if (fence) {
      const marker = fence[1][0];
      if (fencedCodeMarker === marker) {
        fencedCodeMarker = null;
      } else if (fencedCodeMarker == null) {
        fencedCodeMarker = marker;
      }
    } else if (fencedCodeMarker == null && SLIDE_SEPARATOR_PATTERN.test(rawLine)) {
      separators.push(cursor);
    }
    if (lineEnd === -1) {
      break;
    }
    cursor = lineEnd + 1;
  }
  return separators;
}

function lineEndOffset(source: string, lineStart: number): number {
  const lineEnd = source.indexOf("\n", lineStart);
  return lineEnd === -1 ? source.length : lineEnd + 1;
}

function lineNumberAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function slideTitle(markdown: string, slideNumber: number): string {
  const heading = markdown.match(/^ {0,3}#{1,6}[\t ]+(.+)$/m);
  if (heading) {
    return heading[1].replace(/[\t ]+#+[\t ]*$/, "").trim() || `Slide ${slideNumber}`;
  }
  const firstText = markdown.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  return firstText ? firstText.slice(0, 80) : `Slide ${slideNumber}`;
}
function toStructuralHeading(source: string, node: Heading): StructuralHeading | null {
  const position = node.position;
  if (!position || position.start.offset == null || position.end.offset == null) {
    return null;
  }
  const raw = source.slice(position.start.offset, position.end.offset);
  const match = ATX_PATTERN.exec(raw);
  if (!match) {
    return null;
  }
  const level = match[1].length;
  return {
    start: position.start.offset,
    end: position.end.offset,
    line: position.start.line,
    level,
    title: extractAtxTitle(raw, level)
  };
}

function validateHierarchy(headings: StructuralHeading[]): ParseIssue[] {
  const issues: ParseIssue[] = [];
  if (headings[0].level !== 1) {
    issues.push({
      kind: "missing-root",
      line: headings[0].line,
      message: `The hierarchy must start at H1, not H${headings[0].level}.`,
      currentLevel: headings[0].level
    });
  }
  for (let index = 1; index < headings.length; index += 1) {
    const previous = headings[index - 1];
    const current = headings[index];
    if (current.level > previous.level + 1) {
      issues.push({
        kind: "level-jump",
        line: current.line,
        message: `Heading jump from H${previous.level} to H${current.level}; H${previous.level + 1} is missing.`,
        previousLevel: previous.level,
        currentLevel: current.level,
        expectedLevel: previous.level + 1
      });
    }
  }
  return issues;
}

function extractAtxTitle(raw: string, level: number): string {
  return raw
    .slice(raw.indexOf("#") + level)
    .trim()
    .replace(/[\t ]+#+[\t ]*$/, "")
    .trim();
}

function findFrontmatter(source: string): FrontmatterRange | null {
  const bomOffset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const openingEnd = source.indexOf("\n", bomOffset);
  if (openingEnd === -1 || source.slice(bomOffset, openingEnd).replace(/\r$/, "").trim() !== "---") {
    return null;
  }
  let cursor = openingEnd + 1;
  let marp = false;
  while (cursor <= source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const rawLine = source.slice(cursor, end).replace(/\r$/, "");
    const line = rawLine.trim();
    if (line === "---" || line === "...") {
      return { end: lineEnd === -1 ? end : lineEnd + 1, marp };
    }
    if (/^marp\s*:\s*(true|"true"|'true')\s*$/i.test(line)) {
      marp = true;
    }
    if (lineEnd === -1) {
      break;
    }
    cursor = lineEnd + 1;
  }
  return null;
}

function maskFrontmatter(source: string, end: number): string {
  return source.slice(0, end).replace(/[^\r\n]/g, " ") + source.slice(end);
}
