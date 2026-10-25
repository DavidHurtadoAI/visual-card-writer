import { afterEach, describe, expect, it, vi } from "vitest";
import { VisualCardWriterView } from "../src/view";
import { parseCardDocument } from "../src/parser";
import type { CardNode } from "../src/types";

vi.mock("obsidian", () => ({ TextFileView: class {} }));

class FakeNode {}

interface KeydownHarness {
  handleCardKeydown(event: KeyboardEvent, card: CardNode, siblings: string[]): void;
  selectCard: ReturnType<typeof vi.fn>;
  createChildCard: ReturnType<typeof vi.fn>;
  createSiblingCardBelow: ReturnType<typeof vi.fn>;
  startEditing: ReturnType<typeof vi.fn>;
}

function keydown(key: string, target: unknown, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    target,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...modifiers
  } as unknown as KeyboardEvent;
}

function harness(editorContains: (target: unknown) => boolean): KeydownHarness {
  return Object.assign(Object.create(VisualCardWriterView.prototype) as KeydownHarness, {
    editor: { dom: { contains: editorContains } },
    layoutOrientation: "horizontal",
    collapsedCardIds: new Set<string>(),
    selectCard: vi.fn(),
    createChildCard: vi.fn(),
    createSiblingCardBelow: vi.fn(),
    startEditing: vi.fn()
  });
}

describe("card keydown handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  const parsed = parseCardDocument("# Root\n## First\nText\n## Second\nMore text");
  const first = parsed.cards.find((card) => card.title === "First")!;
  const siblings = parsed.cards.filter((card) => card.parentId === first.parentId).map((card) => card.id);

  it.each([
    ["ArrowDown", {}],
    ["ArrowUp", {}],
    ["ArrowLeft", {}],
    ["ArrowRight", {}],
    ["Home", {}],
    ["End", {}],
    ["Enter", {}],
    ["ArrowDown", { metaKey: true }],
    ["ArrowRight", { ctrlKey: true }]
  ])("leaves %s %j to the embedded editor while editing", (key, modifiers) => {
    vi.stubGlobal("Node", FakeNode);
    const editorTarget = new FakeNode();
    const view = harness((target) => target === editorTarget);
    const preventDefault = vi.fn();
    const event = keydown(key, editorTarget, { ...modifiers, preventDefault });

    view.handleCardKeydown(event, first, siblings);

    expect(view.selectCard).not.toHaveBeenCalled();
    expect(view.createChildCard).not.toHaveBeenCalled();
    expect(view.createSiblingCardBelow).not.toHaveBeenCalled();
    expect(view.startEditing).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("still navigates between cards when the key comes from the card itself", () => {
    vi.stubGlobal("Node", FakeNode);
    const cardTarget = new FakeNode();
    const view = harness(() => false);

    view.handleCardKeydown(keydown("ArrowDown", cardTarget), first, siblings);

    expect(view.selectCard).toHaveBeenCalledWith(siblings[siblings.indexOf(first.id) + 1]);
  });
});
