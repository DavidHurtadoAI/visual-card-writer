import type { CardNode, LayoutOrientation } from "./types";

export type CardEmphasis = "selected" | "active-path" | "available";
export type DropPlacement = "before" | "after" | "child";

export interface TreeLayout {
  tops: Map<string, number>;
  subtreeHeights: Map<string, number>;
  totalHeight: number;
}

export interface CardDimensions {
  width: number;
  height: number;
}

export interface LayoutNavigationKeys {
  previous: "ArrowUp" | "ArrowLeft";
  next: "ArrowDown" | "ArrowRight";
  parent: "ArrowLeft" | "ArrowUp";
  child: "ArrowRight" | "ArrowDown";
}

export interface CardSurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ConnectorPoint {
  x: number;
  y: number;
}

export interface OrthogonalConnectorGeometry {
  path: string;
  arrowTips: ConnectorPoint[];
}

export function groupCardsByDepth(cards: CardNode[]): string[][] {
  const columns: string[][] = [];
  for (const card of cards) {
    const index = card.depth;
    (columns[index] ??= []).push(card.id);
  }
  return columns;
}

export function getBranchCardIds(cards: CardNode[]): string[] {
  return cards.filter((card) => card.children.length > 0).map((card) => card.id);
}

export function getVisibleCards(cards: CardNode[], collapsedCardIds: ReadonlySet<string>): CardNode[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const hidden = new Set<string>();

  const hideDescendants = (cardId: string): void => {
    const card = byId.get(cardId);
    if (!card) {
      return;
    }
    for (const childId of card.children) {
      if (!hidden.has(childId)) {
        hidden.add(childId);
        hideDescendants(childId);
      }
    }
  };

  for (const cardId of collapsedCardIds) {
    hideDescendants(cardId);
  }

  return cards
    .filter((card) => !hidden.has(card.id))
    .map((card) => ({
      ...card,
      children: collapsedCardIds.has(card.id)
        ? []
        : card.children.filter((childId) => !hidden.has(childId))
    }));
}

export function getOpenBranchDescendants(
  cards: CardNode[],
  ancestorId: string,
  collapsedCardIds: ReadonlySet<string>
): string[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const openBranches: string[] = [];

  const visitOpenChildren = (cardId: string): void => {
    const card = byId.get(cardId);
    if (!card) {
      return;
    }
    for (const childId of card.children) {
      const child = byId.get(childId);
      if (!child || child.children.length === 0 || collapsedCardIds.has(childId)) {
        continue;
      }
      visitOpenChildren(childId);
      openBranches.push(childId);
    }
  };

  visitOpenChildren(ancestorId);
  return openBranches;
}

export function getCardEmphasis(
  card: CardNode,
  selectedCardId: string | null,
  activePathIds: ReadonlySet<string>
): CardEmphasis {
  if (card.id === selectedCardId) {
    return "selected";
  }
  if (activePathIds.has(card.id)) {
    return "active-path";
  }
  return "available";
}

export function computeTreeLayout(
  cards: CardNode[],
  roots: string[],
  cardHeights: ReadonlyMap<string, number>,
  gap: number
): TreeLayout {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const tops = new Map<string, number>();
  const subtreeHeights = new Map<string, number>();

  const placeSubtree = (cardId: string, top: number): number => {
    const card = byId.get(cardId);
    if (!card) {
      return 0;
    }
    tops.set(cardId, top);

    let childrenHeight = 0;
    let childTop = top;
    for (const childId of card.children) {
      const childHeight = placeSubtree(childId, childTop);
      childrenHeight += childHeight;
      childTop += childHeight + gap;
    }
    if (card.children.length > 0) {
      childrenHeight += gap * (card.children.length - 1);
    }

    const ownHeight = cardHeights.get(cardId) ?? 0;
    const subtreeHeight = Math.max(ownHeight, childrenHeight);
    subtreeHeights.set(cardId, subtreeHeight);
    return subtreeHeight;
  };

  let rootTop = 0;
  for (const rootId of roots) {
    const rootHeight = placeSubtree(rootId, rootTop);
    rootTop += rootHeight + gap;
  }

  return {
    tops,
    subtreeHeights,
    totalHeight: roots.length > 0 ? Math.max(0, rootTop - gap) : 0
  };
}

export function computeBranchAxisLayout(
  cards: CardNode[],
  roots: string[],
  cardDimensions: ReadonlyMap<string, CardDimensions>,
  gap: number,
  orientation: LayoutOrientation
): TreeLayout {
  const branchSizes = new Map(
    [...cardDimensions].map(([id, dimensions]) => [
      id,
      orientation === "horizontal" ? dimensions.height : dimensions.width
    ])
  );
  return computeTreeLayout(cards, roots, branchSizes, gap);
}

export function getDropPlacementForPoint(
  card: CardSurfaceRect,
  pointer: ConnectorPoint,
  orientation: LayoutOrientation,
  allowChildPlacement: boolean
): DropPlacement {
  const relativeX = pointer.x - card.left;
  const relativeY = pointer.y - card.top;
  if (!allowChildPlacement) {
    return orientation === "horizontal"
      ? relativeY < card.height / 2 ? "before" : "after"
      : relativeX < card.width / 2 ? "before" : "after";
  }
  if (orientation === "horizontal") {
    if (relativeY < card.height * 0.26) {
      return "before";
    }
    if (relativeY > card.height * 0.74) {
      return "after";
    }
    return relativeX > card.width * 0.58 ? "child" : "after";
  }
  if (relativeX < card.width * 0.26) {
    return "before";
  }
  if (relativeX > card.width * 0.74) {
    return "after";
  }
  return relativeY > card.height * 0.58 ? "child" : "after";
}

export function getLayoutNavigationKeys(orientation: LayoutOrientation): LayoutNavigationKeys {
  return orientation === "horizontal"
    ? { previous: "ArrowUp", next: "ArrowDown", parent: "ArrowLeft", child: "ArrowRight" }
    : { previous: "ArrowLeft", next: "ArrowRight", parent: "ArrowUp", child: "ArrowDown" };
}

export function getOrthogonalConnectorGeometry(
  parent: CardSurfaceRect,
  children: CardSurfaceRect[],
  orientation: LayoutOrientation,
  arrowClearance = 4
): OrthogonalConnectorGeometry {
  if (children.length === 0) {
    return { path: "", arrowTips: [] };
  }
  if (orientation === "horizontal") {
    const start = { x: parent.left + parent.width, y: parent.top + parent.height / 2 };
    const arrowTips = children.map((child) => ({ x: child.left, y: child.top + child.height / 2 }));
    const junctionX = (start.x + Math.min(...arrowTips.map((tip) => tip.x))) / 2;
    const busMinimum = Math.min(start.y, ...arrowTips.map((tip) => tip.y));
    const busMaximum = Math.max(start.y, ...arrowTips.map((tip) => tip.y));
    const segments = [
      `M ${start.x} ${start.y} H ${junctionX}`,
      `M ${junctionX} ${busMinimum} V ${busMaximum}`,
      ...arrowTips.map((tip) => `M ${junctionX} ${tip.y} H ${Math.max(junctionX, tip.x - arrowClearance)}`)
    ];
    return { path: segments.join(" "), arrowTips };
  }
  const start = { x: parent.left + parent.width / 2, y: parent.top + parent.height };
  const arrowTips = children.map((child) => ({ x: child.left + child.width / 2, y: child.top }));
  const junctionY = (start.y + Math.min(...arrowTips.map((tip) => tip.y))) / 2;
  const busMinimum = Math.min(start.x, ...arrowTips.map((tip) => tip.x));
  const busMaximum = Math.max(start.x, ...arrowTips.map((tip) => tip.x));
  const segments = [
    `M ${start.x} ${start.y} V ${junctionY}`,
    `M ${busMinimum} ${junctionY} H ${busMaximum}`,
    ...arrowTips.map((tip) => `M ${tip.x} ${junctionY} V ${Math.max(junctionY, tip.y - arrowClearance)}`)
  ];
  return { path: segments.join(" "), arrowTips };
}
