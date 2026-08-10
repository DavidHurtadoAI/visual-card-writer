export interface CardRange {
  start: number;
  headingEnd: number;
  end: number;
  line: number;
}

export interface CardNode {
  id: string;
  level: number;
  title: string;
  markdown: string;
  parentId: string | null;
  children: string[];
  range: CardRange;
}

export interface ParseIssue {
  line: number;
  message: string;
}

export interface CardDocument {
  cards: CardNode[];
  roots: string[];
  issues: ParseIssue[];
  prologue: string;
}

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
}
