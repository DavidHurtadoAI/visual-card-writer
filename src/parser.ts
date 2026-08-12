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
}

const ATX_PATTERN = /^ {0,3}(#{1,6})(?:[\t ]+|$)/;

export function parseCardDocument(source: string): CardDocument {
  const frontmatter = findFrontmatter(source);
  const parseSource = frontmatter ? maskFrontmatter(source, frontmatter.end) : source;
  const tree = fromMarkdown(parseSource);
  const headings = tree.children
    .filter((node): node is Heading => node.type === "heading" && node.position != null)
    .map((node) => toStructuralHeading(source, node))
    .filter((heading): heading is StructuralHeading => heading != null);

  if (headings.length === 0) {
    return {
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

  const contentStart = frontmatter?.end ?? 0;
  return { cards, roots, issues, prologue: source.slice(contentStart, headings[0].start) };
}

export function needsRootHeading(document: CardDocument): boolean {
  return document.cards.length === 0 || document.cards[0].level !== 1;
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
  while (cursor <= source.length) {
    const lineEnd = source.indexOf("\n", cursor);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const line = source.slice(cursor, end).replace(/\r$/, "").trim();
    if (line === "---" || line === "...") {
      return { end: lineEnd === -1 ? end : lineEnd + 1 };
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
