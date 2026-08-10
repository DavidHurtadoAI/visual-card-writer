import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export type EssentialPreviewTokenKind =
  | "syntax"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4"
  | "heading-5"
  | "heading-6"
  | "strong"
  | "emphasis"
  | "inline-code"
  | "link"
  | "wikilink";

export interface EssentialPreviewToken {
  from: number;
  to: number;
  kind: EssentialPreviewTokenKind;
}

interface WikiRange {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  aliasSeparator: number | null;
}

export function essentialLivePreview(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = decorationsForState(view.state);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet) {
          this.decorations = decorationsForState(update.state);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );
}

export function buildEssentialPreviewTokens(state: EditorState): EssentialPreviewToken[] {
  const tokens: EssentialPreviewToken[] = [];
  const wikiRanges = findWikiRanges(state.doc.toString());
  for (const wiki of wikiRanges) {
    const reveal = selectionTouches(state, wiki.from, wiki.to);
    const labelFrom = wiki.aliasSeparator == null ? wiki.contentFrom : wiki.aliasSeparator + 1;
    tokens.push({ from: labelFrom, to: wiki.contentTo, kind: "wikilink" });
    if (!reveal) {
      tokens.push({ from: wiki.from, to: wiki.contentFrom, kind: "syntax" });
      if (wiki.aliasSeparator != null) {
        tokens.push({ from: wiki.contentFrom, to: wiki.aliasSeparator + 1, kind: "syntax" });
      }
      tokens.push({ from: wiki.contentTo, to: wiki.to, kind: "syntax" });
    }
  }

  syntaxTree(state).iterate({
    enter: (node) => {
      if (insideWikiRange(node.from, node.to, wikiRanges)) {
        return;
      }

      const heading = /^ATXHeading([1-6])$/.exec(node.name);
      if (heading) {
        const kind = `heading-${heading[1]}` as EssentialPreviewTokenKind;
        tokens.push({ from: node.from, to: node.to, kind });
        if (!selectionTouches(state, node.from, node.to)) {
          const cursor = node.node.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === "HeaderMark") {
                tokens.push({ from: cursor.from, to: cursor.to, kind: "syntax" });
              }
            } while (cursor.nextSibling());
          }
        }
        return;
      }

      const semanticKind = semanticKindForNode(node.name);
      if (semanticKind) {
        tokens.push({ from: node.from, to: node.to, kind: semanticKind });
      }

      if ((node.name === "StrongEmphasis" || node.name === "Emphasis" || node.name === "InlineCode") &&
          !selectionTouches(state, node.from, node.to)) {
        const cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do {
            if (cursor.name === "EmphasisMark" || cursor.name === "CodeMark") {
              tokens.push({ from: cursor.from, to: cursor.to, kind: "syntax" });
            }
          } while (cursor.nextSibling());
        }
        return;
      }

      if (node.name === "Link") {
        decorateMarkdownLink(state, node.node.cursor(), node.from, node.to, tokens);
      }
    }
  });

  return tokens.filter((token) => token.to > token.from);
}

function decorationsForState(state: EditorState): DecorationSet {
  const ranges = buildEssentialPreviewTokens(state).map((token) => {
    if (token.kind === "syntax") {
      return Decoration.replace({}).range(token.from, token.to);
    }
    return Decoration.mark({ class: `cm-vcw-${token.kind}` }).range(token.from, token.to);
  });
  return Decoration.set(ranges, true);
}

function semanticKindForNode(name: string): EssentialPreviewTokenKind | null {
  if (name === "StrongEmphasis") {
    return "strong";
  }
  if (name === "Emphasis") {
    return "emphasis";
  }
  if (name === "InlineCode") {
    return "inline-code";
  }
  return null;
}

function decorateMarkdownLink(
  state: EditorState,
  cursor: ReturnType<ReturnType<typeof syntaxTree>["cursor"]>,
  from: number,
  to: number,
  tokens: EssentialPreviewToken[]
): void {
  const marks: Array<{ from: number; to: number; text: string }> = [];
  let url: { from: number; to: number } | null = null;
  if (cursor.firstChild()) {
    do {
      if (cursor.name === "LinkMark") {
        marks.push({ from: cursor.from, to: cursor.to, text: state.sliceDoc(cursor.from, cursor.to) });
      } else if (cursor.name === "URL") {
        url = { from: cursor.from, to: cursor.to };
      }
    } while (cursor.nextSibling());
  }
  const opening = marks[0];
  const labelEnd = marks.find((mark) => mark.text === "]");
  if (opening && labelEnd && labelEnd.from > opening.to) {
    tokens.push({ from: opening.to, to: labelEnd.from, kind: "link" });
  }
  if (selectionTouches(state, from, to)) {
    return;
  }
  for (const mark of marks) {
    tokens.push({ from: mark.from, to: mark.to, kind: "syntax" });
  }
  if (url) {
    tokens.push({ from: url.from, to: url.to, kind: "syntax" });
  }
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function findWikiRanges(source: string): WikiRange[] {
  const ranges: WikiRange[] = [];
  const pattern = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) != null) {
    const from = match.index;
    const contentFrom = from + 2;
    const contentTo = from + match[0].length - 2;
    const separatorWithinContent = match[1].indexOf("|");
    ranges.push({
      from,
      to: from + match[0].length,
      contentFrom,
      contentTo,
      aliasSeparator: separatorWithinContent >= 0 ? contentFrom + separatorWithinContent : null
    });
  }
  return ranges;
}

function insideWikiRange(from: number, to: number, ranges: WikiRange[]): boolean {
  return ranges.some((range) => from >= range.from && to <= range.to);
}
