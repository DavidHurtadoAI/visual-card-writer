export interface CardRange {
  start: number;
  headingEnd: number;
  end: number;
  line: number;
}

export interface CardNode {
  id: string;
  level: number;
  depth: number;
  title: string;
  markdown: string;
  parentId: string | null;
  children: string[];
  range: CardRange;
}

export type ParseIssue =
  | {
      kind: "no-headings";
      line: number;
      message: string;
    }
  | {
      kind: "missing-root";
      line: number;
      message: string;
      currentLevel: number;
    }
  | {
      kind: "level-jump";
      line: number;
      message: string;
      previousLevel: number;
      currentLevel: number;
      expectedLevel: number;
    };

export interface CardDocument {
  cards: CardNode[];
  roots: string[];
  issues: ParseIssue[];
  prologue: string;
}

export type LayoutOrientation = "horizontal" | "vertical";

export interface ViewDiagnostics {
  viewType: string;
  file: string | null;
  cards: number;
  roots: number;
  selectedCard: string | null;
  selectedTitle: string | null;
  activeEditors: number;
  editorMounts: number;
  editorDestroys: number;
  parseIssues: number;
  dataLength: number;
  sessionRevision: number;
  sessionConflict: boolean;
  rememberedColumnWidths: number;
  rememberedCardHeights: number;
  visibleCards: number;
  collapsedCards: number;
  zoomLevel: number;
  layoutOrientation: LayoutOrientation;
}
