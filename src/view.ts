import {
  Component,
  MarkdownRenderer,
  Menu,
  Notice,
  TextFileView,
  WorkspaceLeaf,
  setIcon
} from "obsidian";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  rectangularSelection
} from "@codemirror/view";
import {
  hasBlockingIssues,
  needsRootHeading,
  parseCardDocument,
  reconcileCard,
  replaceCardFragment,
  withSyntheticRootHeading
} from "./parser";
import { getHierarchyGuidance } from "./hierarchy-guidance";
import {
  computeBranchAxisLayout,
  getCardEmphasis,
  getDragPreviewPosition,
  getDropPlacementForPoint,
  getOrthogonalConnectorGeometry,
  getBranchCardIds,
  getLayoutNavigationKeys,
  getOpenBranchDescendants,
  getVisibleCards,
  groupCardsByDepth
} from "./layout";
import {
  anchoredScrollOffset,
  centeredScrollOffset,
  edgeAutoScrollVelocity,
  resizeWorldDelta,
  scrollAnimationDuration,
  zoomFromWheel
} from "./navigation";
import { insertCard, insertMissingParent, moveCard, promoteCardBranch } from "./operations";
import type { CardInsertionKind, CardInsertionResult, CardMovePlacement, HeadingRepairResult } from "./operations";
import { essentialLivePreview } from "./live-preview";
import { DocumentSession, DocumentSessionRegistry } from "./session";
import type { SessionSnapshot } from "./session";
import type { CardDocument, CardNode, LayoutOrientation, ParseIssue, ViewDiagnostics } from "./types";

export const CARD_VIEW_TYPE = "visual-card-writer-view";

export interface FocusDimmingController {
  get(): boolean;
  set(enabled: boolean): Promise<void>;
}

interface CardTransitionItem {
  id: string;
  rect: DOMRect;
  opacity: number;
  ghost: HTMLElement;
}

interface CardTransitionSnapshot {
  token: number;
  triggerId: string;
  triggerRect: DOMRect;
  scrollLeft: number;
  scrollTop: number;
  items: CardTransitionItem[];
}

type LevelJumpIssue = Extract<ParseIssue, { kind: "level-jump" }>;

export class VisualCardWriterView extends TextFileView {
  private parsed: CardDocument = { structure: "headings", cards: [], roots: [], issues: [], prologue: "" };
  private selectedCardId: string | null = null;
  private editor: EditorView | null = null;
  private editingCardId: string | null = null;
  private editingRangeStart = 0;
  private editingRangeEnd = 0;
  private renderComponent: Component | null = null;
  private renderGeneration = 0;
  private editorMounts = 0;
  private editorDestroys = 0;
  private session: DocumentSession | null = null;
  private sessionPath: string | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private editingBaseMarkdown = "";
  private applyingSessionUpdate = false;
  private sessionConflict = false;
  private pendingSessionSnapshot: SessionSnapshot | null = null;
  private columnWidths = new Map<number, number>();
  private cardHeights = new Map<string, number>();
  private collapsedCardIds = new Set<string>();
  private layoutResizeObserver: ResizeObserver | null = null;
  private layoutAnimationFrame: number | null = null;
  private renderingCardLayoutGeneration: number | null = null;
  private zoomLevel = 1;
  private collapseStateInitialized = false;
  private viewportScrollAnimationFrame: number | null = null;
  private cardTransitionToken = 0;
  private cardTransitionAnimations: Animation[] = [];
  private cardTransitionGhosts: HTMLElement[] = [];
  private cardTransitionHiddenElements: HTMLElement[] = [];
  private cardTransitionCleanupTimer: number | null = null;
  private layoutOrientation: LayoutOrientation = "horizontal";
  private cardTransitionOverlay: HTMLElement | null = null;
  private draggingCardId: string | null = null;
  private dragTargetCardId: string | null = null;
  private dragPlacement: CardMovePlacement | null = null;
  private dropTargetClearTimer: number | null = null;
  private pendingDropTargetTimer: number | null = null;
  private pendingDropTargetCardId: string | null = null;
  private pendingDropPlacement: CardMovePlacement | null = null;
  private lastDragClientX: number | null = null;
  private lastDragClientY: number | null = null;
  private dragWheelAnimationFrame: number | null = null;
  private pendingDragWheelDeltaX = 0;
  private pendingDragWheelDeltaY = 0;
  private dragWheelViewport: HTMLElement | null = null;
  private dragWheelListener: ((event: WheelEvent) => void) | null = null;
  private dragPreviewElement: HTMLElement | null = null;
  private dragOriginElements: HTMLElement[] = [];
  private suppressNextCardClick = false;
  private focusDimmingEnabled = true;
  private focusDimmingButton: HTMLButtonElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly sessions: DocumentSessionRegistry,
    private readonly focusDimming: FocusDimmingController
  ) {
    super(leaf);
    this.focusDimmingEnabled = focusDimming.get();
  }

  getViewType(): string {
    return CARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? `${this.file.basename} - Cards` : "Visual Card Writer";
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  getViewData(): string {
    return this.data;
  }

  setViewData(data: string, clear: boolean): void {
    if (clear) {
      this.destroyEditor();
      this.selectedCardId = null;
    }
    const filePath = this.file?.path;
    if (!filePath) {
      this.applyDocumentText(data);
      return;
    }
    if (this.sessionPath !== filePath) {
      this.layoutOrientation = "horizontal";
      this.applyLayoutOrientationClass();
      const existing = this.sessions.get(filePath);
      this.bindSession(filePath, data);
      this.applyDocumentText(existing?.text ?? data);
      return;
    }
    if (this.session && data !== this.session.text) {
      const snapshot = this.session.commit(data, this, "external");
      this.receiveSessionSnapshot(snapshot, true);
      return;
    }
    const nextText = this.session?.text ?? data;
    if (!clear && nextText === this.data && this.hasRenderedDocument()) {
      return;
    }
    this.applyDocumentText(nextText);
  }

  clear(): void {
    this.cancelCardTransition();
    this.cancelViewportScrollAnimation();
    this.clearCardDragState();
    this.renderGeneration += 1;
    this.destroyEditor();
    this.renderComponent?.unload();
    this.renderComponent = null;
    this.stopCardLayout();
    this.contentEl.empty();
    this.focusDimmingButton = null;
    this.parsed = { structure: "headings", cards: [], roots: [], issues: [], prologue: "" };
    this.selectedCardId = null;
    this.collapsedCardIds.clear();
    this.columnWidths.clear();
    this.cardHeights.clear();
    this.collapseStateInitialized = false;
    this.zoomLevel = 1;
    this.layoutOrientation = "horizontal";
    this.applyLayoutOrientationClass();
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("visual-card-writer-view");
    this.applyLayoutOrientationClass();
    this.setFocusDimmingEnabled(this.focusDimming.get());
    this.registerDomEvent(this.contentEl, "click", (event) => this.handleViewClick(event));
    this.addAction("file-text", "Switch back to Markdown editor", () => {
      void this.switchToMarkdown();
    });
    await this.renderView();
  }

  async toggleLayoutOrientation(): Promise<void> {
    await this.setLayoutOrientation(this.layoutOrientation === "horizontal" ? "vertical" : "horizontal");
  }

  async toggleFocusDimming(): Promise<void> {
    await this.focusDimming.set(!this.focusDimmingEnabled);
  }

  setFocusDimmingEnabled(enabled: boolean): void {
    this.focusDimmingEnabled = enabled;
    this.containerEl.toggleClass("is-focus-dimming-enabled", enabled);
    this.updateFocusDimmingButton();
  }

  async setLayoutOrientation(orientation: LayoutOrientation): Promise<void> {
    if (orientation === this.layoutOrientation) {
      return;
    }
    if (this.editor) {
      await this.finishEditing(true);
    }
    this.cancelCardTransition();
    this.cancelViewportScrollAnimation();
    this.layoutOrientation = orientation;
    this.applyLayoutOrientationClass();
    await this.renderView();
    if (this.selectedCardId) {
      this.animateViewportToCard(this.selectedCardId);
    }
  }

  async onClose(): Promise<void> {
    this.unbindSession();
    this.clear();
  }

  async switchToMarkdown(): Promise<void> {
    if (!this.file) {
      return;
    }
    await this.finishEditing(true);
    if (this.editor) {
      return;
    }
    await this.leaf.setViewState({
      type: "markdown",
      state: { file: this.file.path, mode: "source" },
      active: true
    });
  }

  async startEditing(cardId = this.selectedCardId, selectHeadingTitle = false): Promise<void> {
    if (!cardId) {
      return;
    }
    if (this.editor && this.editingCardId === cardId) {
      this.editor.focus();
      return;
    }
    if (this.editor) {
      await this.finishEditing(true);
    }
    this.selectedCardId = cardId;
    const card = this.cardById(cardId);
    if (!card) {
      return;
    }

    let host = this.cardBodyElement(cardId);
    if (!host) {
      await this.renderView();
      host = this.cardBodyElement(cardId);
    }
    if (!host) {
      throw new Error(`Cannot find a DOM host for ${cardId}.`);
    }
    host.empty();
    host.addClass("visual-card-writer-editor-host");
    this.cardElement(cardId)?.addClass("is-editing");

    this.editingCardId = cardId;
    this.editingRangeStart = card.range.start;
    this.editingRangeEnd = card.range.end;
    this.editingBaseMarkdown = card.markdown;
    this.sessionConflict = false;
    this.pendingSessionSnapshot = null;
    const requiredPrefix = card.kind === "heading" ? `${"#".repeat(card.level)} ` : null;

    this.editor = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: card.markdown,
        extensions: [
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          markdown(),
          essentialLivePreview(),
          EditorState.transactionFilter.of((transaction) => {
            if (!transaction.docChanged) {
              return transaction;
            }
            const fragment = transaction.newDoc.toString();
            if (requiredPrefix && !fragment.startsWith(requiredPrefix)) {
              new Notice(`The structural ${requiredPrefix.trim()} prefix is protected in this editor.`);
              return [];
            }
            const candidate =
              this.data.slice(0, this.editingRangeStart) +
              fragment +
              this.data.slice(this.editingRangeEnd);
            if (hasBlockingIssues(parseCardDocument(candidate))) {
              new Notice("That edit would create an invalid ATX hierarchy.");
              return [];
            }
            return transaction;
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || this.applyingSessionUpdate) {
              return;
            }
            const fragment = update.state.doc.toString();
            const activeCard = this.editingCard();
            if (!activeCard) {
              return;
            }
            this.data = replaceCardFragment(this.data, activeCard, fragment);
            this.editingRangeEnd = this.editingRangeStart + fragment.length;
            this.session?.commit(this.data, this, "local");
            this.requestSave();
          }),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                void this.finishEditing(true);
                return true;
              }
            },
            {
              key: "Escape",
              run: () => {
                void this.finishEditing(true);
                return true;
              }
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap
          ]),
          EditorView.lineWrapping
        ]
      })
    });
    this.editorMounts += 1;
    if (requiredPrefix && selectHeadingTitle && card.title.length > 0) {
      const titleStart = card.markdown.indexOf(card.title, requiredPrefix.length);
      if (titleStart >= 0) {
        this.editor.dispatch({
          selection: { anchor: titleStart, head: titleStart + card.title.length }
        });
      }
    }
    this.editor.focus();
  }

  async finishEditing(persist: boolean): Promise<void> {
    if (!this.editor || !this.editingCardId) {
      return;
    }
    if (this.sessionConflict) {
      new Notice("This card changed in another view. The local draft was not overwritten or saved.");
      return;
    }
    const previous = this.editingCard();
    const previousDocument = this.parsed;
    this.destroyEditor();
    const next = parseCardDocument(this.data);
    this.parsed = next;
    const selectedCard = previous ? reconcileCard(previous, next) : null;
    if (previous) {
      this.selectedCardId = selectedCard?.id ?? next.roots[0] ?? null;
    }
    if (
      previous &&
      selectedCard &&
      this.canPatchEditedCardInPlace(previousDocument, next) &&
      await this.renderCardBody(selectedCard.id)
    ) {
      this.updateSelectionPresentation();
      this.layoutCards();
    } else {
      await this.renderView();
    }
    if (this.selectedCardId) {
      this.cardElement(this.selectedCardId)?.focus({ preventScroll: true });
    }
    if (persist) {
      await this.save();
    }
  }

  async replaceActiveCardForDiagnostics(content: string): Promise<ViewDiagnostics> {
    await this.startEditing();
    if (!this.editor) {
      throw new Error("No active card editor is available.");
    }
    this.editor.dispatch({
      changes: { from: 0, to: this.editor.state.doc.length, insert: content }
    });
    await this.finishEditing(true);
    return this.getDiagnostics();
  }

  async cycleEditorForDiagnostics(count: number): Promise<ViewDiagnostics> {
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      throw new Error("count must be an integer between 1 and 200.");
    }
    for (let index = 0; index < count; index += 1) {
      await this.startEditing();
      await this.finishEditing(false);
    }
    return this.getDiagnostics();
  }

  canCreateChildCard(cardId = this.selectedCardId): boolean {
    const card = cardId ? this.cardById(cardId) : null;
    return card != null && this.parsed.structure === "headings" && card.level < 6 && !hasBlockingIssues(this.parsed) && !this.sessionConflict;
  }

  canCreateSiblingCard(cardId = this.selectedCardId): boolean {
    return cardId != null && this.parsed.structure === "headings" && this.cardById(cardId) != null && !hasBlockingIssues(this.parsed) && !this.sessionConflict;
  }

  async createChildCard(cardId = this.selectedCardId): Promise<void> {
    await this.createRelativeCard("child", cardId);
  }

  async createSiblingCardBelow(cardId = this.selectedCardId): Promise<void> {
    await this.createRelativeCard("sibling", cardId);
  }

  getDiagnostics(): ViewDiagnostics {
    const selected = this.selectedCardId ? this.cardById(this.selectedCardId) : null;
    return {
      viewType: this.getViewType(),
      file: this.file?.path ?? null,
      cards: this.parsed.cards.length,
      roots: this.parsed.roots.length,
      selectedCard: selected?.id ?? null,
      selectedTitle: selected?.title ?? null,
      activeEditors: this.editor ? 1 : 0,
      editorMounts: this.editorMounts,
      editorDestroys: this.editorDestroys,
      parseIssues: this.parsed.issues.length,
      dataLength: this.data.length,
      sessionRevision: this.session?.revision ?? 0,
      sessionConflict: this.sessionConflict,
      rememberedColumnWidths: this.columnWidths.size,
      rememberedCardHeights: this.cardHeights.size,
      visibleCards: getVisibleCards(this.parsed.cards, this.collapsedCardIds).length,
      collapsedCards: this.collapsedCardIds.size,
      zoomLevel: this.zoomLevel,
      layoutOrientation: this.layoutOrientation,
      focusDimmingEnabled: this.focusDimmingEnabled
    };
  }

  private async renderView(minBusyMs = 0): Promise<void> {
    if (this.editor) {
      return;
    }
    this.cancelViewportScrollAnimation();
    this.clearCardDragState();
    const previousViewport = this.contentEl.querySelector<HTMLElement>(".visual-card-writer-columns");
    const previousScrollLeft = previousViewport?.scrollLeft ?? 0;
    const previousScrollTop = previousViewport?.scrollTop ?? 0;
    const generation = ++this.renderGeneration;
    this.renderingCardLayoutGeneration = generation;
    this.renderComponent?.unload();
    this.stopCardLayout();
    this.layoutResizeObserver = new ResizeObserver(() => this.scheduleCardLayout());
    const component = new Component();
    component.load();
    this.renderComponent = component;
    this.contentEl.empty();

    const toolbar = this.contentEl.createDiv({ cls: "visual-card-writer-toolbar" });
    const title = toolbar.createDiv({ cls: "visual-card-writer-title" });
    title.setText(this.file?.basename ?? "Visual Card Writer");
    this.createOrientationToggle(toolbar);
    this.createFocusDimmingToggle(toolbar);
    const zoomButton = toolbar.createEl("button", {
      cls: "visual-card-writer-zoom-indicator",
      text: `${Math.round(this.zoomLevel * 100)}%`,
      attr: {
        "aria-label": "Reset card zoom",
        title: "Middle-drag to pan - Wheel to scroll - Shift + wheel sideways - Ctrl/Cmd + wheel to zoom - Click to reset"
      }
    });
    zoomButton.addEventListener("click", () => {
      const viewport = this.contentEl.querySelector<HTMLElement>(".visual-card-writer-columns");
      if (!viewport) {
        return;
      }
      const bounds = viewport.getBoundingClientRect();
      this.setZoomAtViewportPoint(1, viewport, bounds.width / 2, bounds.height / 2);
    });
    const expandAllButton = toolbar.createEl("button", {
      cls: ["visual-card-writer-toolbar-button", "clickable-icon"],
      attr: {
        "aria-label": "Expand all cards",
        title: "Expand all cards"
      }
    });
    setIcon(expandAllButton, "maximize-2");
    expandAllButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.expandAllCards();
    });
    const collapseAllButton = toolbar.createEl("button", {
      cls: ["visual-card-writer-toolbar-button", "clickable-icon"],
      attr: {
        "aria-label": "Collapse all cards",
        title: "Collapse all cards"
      }
    });
    setIcon(collapseAllButton, "minimize-2");
    collapseAllButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.collapseAllCards();
    });
    const markdownButton = toolbar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open Markdown editor" } });
    setIcon(markdownButton, "file-text");
    markdownButton.addEventListener("click", () => void this.switchToMarkdown());

    const blockingIssues = this.parsed.issues.filter((issue) => issue.kind !== "level-jump");
    if (blockingIssues.length > 0) {
      const guidancePanel = this.contentEl.createDiv({
        cls: "visual-card-writer-hierarchy-guidance",
        attr: { role: "note", "aria-label": "Heading structure guidance" }
      });
      guidancePanel.createEl("h3", { text: "This note needs a small heading adjustment" });
      guidancePanel.createEl("p", {
        text: "Your existing headings have not been rewritten. Visual Card Writer needs consecutive heading levels to build clear parent-child relationships between cards."
      });
      const list = guidancePanel.createEl("ul");
      for (const issue of blockingIssues) {
        const guidance = getHierarchyGuidance(issue);
        const item = list.createEl("li");
        item.createEl("strong", { text: guidance.title });
        item.createEl("p", { text: guidance.explanation });
        item.createEl("p", { cls: "visual-card-writer-hierarchy-resolution", text: guidance.resolution });
      }
      this.finishRenderingCardLayout(generation);
      const actions = guidancePanel.createDiv({ cls: "visual-card-writer-hierarchy-actions" });
      const openMarkdownButton = actions.createEl("button", { text: "Open Markdown editor" });
      openMarkdownButton.addEventListener("click", () => void this.switchToMarkdown());
      return;
    }

    const path = this.selectedPath();
    this.renderBreadcrumb(path);

    const columnsElement = this.contentEl.createDiv({
      cls: "visual-card-writer-columns",
      attr: { role: "tree", "aria-label": "Card hierarchy" }
    });
    const busyStartedAt = window.performance.now();
    const busy = columnsElement.createDiv({
      cls: "visual-card-writer-render-busy",
      attr: { role: "status", "aria-label": "Rendering cards" }
    });
    busy.createDiv({ cls: "visual-card-writer-render-spinner" });
    const scene = columnsElement.createDiv({ cls: "visual-card-writer-scene" });
    const surface = scene.createDiv({ cls: "visual-card-writer-surface" });
    this.configureViewport(columnsElement);
    await this.waitForNextPaint();
    if (generation !== this.renderGeneration) {
      component.unload();
      return;
    }
    const visibleCards = getVisibleCards(this.parsed.cards, this.collapsedCardIds);
    const columns = groupCardsByDepth(visibleCards);
    const activePathIds = new Set(path.map((card) => card.id));
    for (let depth = 0; depth < columns.length; depth += 1) {
      const ids = columns[depth];
      const column = surface.createDiv({
        cls: "visual-card-writer-column",
        attr: { "data-depth": String(depth), "aria-label": `Level ${depth + 1}` }
      });
      const rememberedColumnWidth = this.columnWidths.get(depth);
      if (rememberedColumnWidth) {
        column.style.setProperty("--vcw-column-width", `${rememberedColumnWidth}px`);
      }
      for (let index = 0; index < ids.length; index += 1) {
        const card = this.cardById(ids[index]);
        if (!card) {
          continue;
        }
        const emphasis = getCardEmphasis(card, this.selectedCardId, activePathIds);
        const hasChildren = card.children.length > 0;
        const isCollapsed = this.collapsedCardIds.has(card.id);
        const headingJump = this.headingJumpForCard(card);
        const cardElement = column.createEl("article", {
          cls: [
            "visual-card-writer-card",
            `is-${emphasis}`,
            hasChildren ? "has-children" : "",
            isCollapsed ? "is-collapsed" : "",
            headingJump ? "has-heading-jump" : ""
          ],
          attr: {
            "data-card-id": card.id,
            "data-level": String(card.level),
            draggable: "false",
            role: "treeitem",
            tabindex: "0",
            "aria-level": String(card.depth + 1),
            "aria-posinset": String(index + 1),
            "aria-setsize": String(ids.length),
            "aria-selected": String(card.id === this.selectedCardId),
            "data-emphasis": emphasis
          }
        });
        const rememberedHeight = this.cardHeights.get(card.id);
        if (rememberedHeight) {
          cardElement.style.setProperty("--vcw-card-height", `${rememberedHeight}px`);
        }
        cardElement.setAttribute(
          "title",
          this.layoutOrientation === "horizontal"
            ? "Drag the card to reorder it. Drag the right edge to resize the column or the bottom edge to resize this card. Double-click a handle to reset."
            : "Drag the card to reorder it. Drag the right edge to resize every card at this level or the bottom edge to resize this card. Double-click a handle to reset."
        );
        cardElement.draggable = false;
        if (hasChildren) {
          cardElement.setAttribute("aria-expanded", String(!isCollapsed));
          const toggle = cardElement.createEl("button", {
            cls: ["visual-card-writer-collapse-toggle", "clickable-icon"],
            attr: {
              "aria-label": isCollapsed ? "Expand children" : "Collapse children",
              title: isCollapsed ? "Expand children" : "Collapse children"
            }
          });
          setIcon(toggle, isCollapsed ? "chevron-right" : "chevron-down");
          toggle.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.toggleCardCollapsed(card.id);
          });
          toggle.addEventListener("dblclick", (event) => event.stopPropagation());
          toggle.addEventListener("keydown", (event) => event.stopPropagation());
        }
        if (headingJump) {
          const guidance = getHierarchyGuidance(headingJump);
          const warningButton = cardElement.createEl("button", {
            cls: "visual-card-writer-heading-jump",
            attr: {
              "aria-label": `${guidance.title}. Open repair options.`,
              title: `${guidance.explanation} ${guidance.resolution}`
            }
          });
          const warningIcon = warningButton.createSpan({ cls: "visual-card-writer-heading-jump-icon" });
          setIcon(warningIcon, "triangle-alert");
          warningButton.createSpan({ text: `H${headingJump.currentLevel} - expected H${headingJump.expectedLevel}` });
          warningButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.showHeadingJumpMenu(event, card, headingJump);
          });
          warningButton.addEventListener("dblclick", (event) => event.stopPropagation());
          warningButton.addEventListener("keydown", (event) => event.stopPropagation());
        }
        const editButton = cardElement.createEl("button", {
          cls: ["visual-card-writer-edit-button", "clickable-icon"],
          attr: {
            "aria-label": "Edit card",
            title: "Edit card"
          }
        });
        setIcon(editButton, "pencil");
        editButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.startEditing(card.id);
        });
        editButton.addEventListener("dblclick", (event) => event.stopPropagation());
        editButton.addEventListener("keydown", (event) => event.stopPropagation());
        const addChildButton = cardElement.createEl("button", {
          cls: ["visual-card-writer-add-child-button", "clickable-icon"],
          attr: {
            "aria-label": this.canCreateChildCard(card.id) ? "Add child card" : "Cannot add a child card here",
            title: this.canCreateChildCard(card.id)
              ? "Add child card (Ctrl/Cmd + Right Arrow)"
              : this.parsed.structure === "slides"
                ? "Slides cannot be nested"
                : "Markdown supports at most six heading levels"
          }
        });
        addChildButton.disabled = !this.canCreateChildCard(card.id);
        setIcon(addChildButton, "plus");
        addChildButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void this.createChildCard(card.id);
        });
        addChildButton.addEventListener("dblclick", (event) => event.stopPropagation());
        addChildButton.addEventListener("keydown", (event) => event.stopPropagation());
        this.createCardResizeHandles(cardElement, card.id, depth);
        this.layoutResizeObserver.observe(cardElement);
        this.configureCardDrag(cardElement, card);
        const body = cardElement.createDiv({ cls: ["visual-card-writer-card-body", "markdown-rendered"] });
        cardElement.addEventListener("click", (event) => {
          if (this.consumeSuppressedCardClick(event) || this.isInsideActiveEditor(event)) {
            return;
          }
          void this.selectCard(card.id);
        });
        cardElement.addEventListener("dblclick", (event) => {
          if (this.isInsideActiveEditor(event)) {
            return;
          }
          void this.startEditing(card.id);
        });
        cardElement.addEventListener("keydown", (event) => this.handleCardKeydown(event, card, ids));
        try {
          await MarkdownRenderer.render(this.app, card.markdown, body, this.file?.path ?? "", component);
        } catch (error) {
          body.setText(card.markdown);
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Visual Card Writer could not render ${card.id}: ${message}`);
        }
        if (generation !== this.renderGeneration) {
          component.unload();
          return;
        }
      }
    }
    this.finishRenderingCardLayout(generation);
    this.layoutCards(false);
    columnsElement.scrollLeft = previousScrollLeft;
    columnsElement.scrollTop = previousScrollTop;
    const remainingBusyMs = minBusyMs - (window.performance.now() - busyStartedAt);
    if (remainingBusyMs > 0) {
      await this.wait(remainingBusyMs);
      if (generation !== this.renderGeneration) {
        component.unload();
        return;
      }
    }
    columnsElement.addClass("is-laid-out");
  }

  private async selectCard(cardId: string): Promise<void> {
    this.cancelViewportScrollAnimation();
    if (!this.collapsedCardIds.has(cardId)) {
      this.cancelCardTransition();
    }
    if (this.editor && this.editingCardId !== cardId) {
      await this.finishEditing(true);
    }
    this.selectedCardId = cardId;
    const transition = this.collapsedCardIds.has(cardId) ? this.captureCardTransition(cardId) : null;
    const visibleCardsChanged = this.expandCard(cardId);
    if (visibleCardsChanged) {
      await this.renderView();
      this.animateCardTransition(transition);
    } else {
      this.updateSelectionPresentation();
    }
    const element = this.cardElement(cardId);
    element?.focus({ preventScroll: true });
    this.animateViewportToCard(cardId);
  }

  private expandCard(cardId: string | null): boolean {
    if (!cardId || !this.collapsedCardIds.has(cardId)) {
      return false;
    }
    this.collapsedCardIds.delete(cardId);
    return true;
  }

  private handleCardKeydown(event: KeyboardEvent, card: CardNode, siblings: string[]): void {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && !event.shiftKey && event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      void this.createChildCard(card.id);
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      void this.createSiblingCardBelow(card.id);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void this.startEditing(card.id);
      return;
    }
    const index = siblings.indexOf(card.id);
    let target: string | null = null;
    const navigationKeys = getLayoutNavigationKeys(this.layoutOrientation);
    if (event.key === navigationKeys.previous || event.key === "Home") {
      target = siblings[event.key === "Home" ? 0 : Math.max(0, index - 1)] ?? null;
    } else if (event.key === navigationKeys.next || event.key === "End") {
      target = siblings[event.key === "End" ? siblings.length - 1 : Math.min(siblings.length - 1, index + 1)] ?? null;
    } else if (event.key === navigationKeys.parent) {
      if (card.children.length > 0 && !this.collapsedCardIds.has(card.id)) {
        event.preventDefault();
        void this.toggleCardCollapsed(card.id);
        return;
      }
      target = card.parentId;
    } else if (event.key === navigationKeys.child) {
      if (card.children.length > 0 && this.collapsedCardIds.has(card.id)) {
        event.preventDefault();
        void this.toggleCardCollapsed(card.id);
        return;
      }
      target = card.children[0] ?? null;
    }
    if (target) {
      event.preventDefault();
      void this.selectCard(target);
    }
  }

  private async createRelativeCard(kind: CardInsertionKind, requestedCardId: string | null): Promise<void> {
    let targetCardId = requestedCardId;
    if (this.editor) {
      await this.finishEditing(true);
      targetCardId = this.selectedCardId;
    }
    if (!targetCardId) {
      new Notice("Select a card before creating a new one.");
      return;
    }
    const target = this.cardById(targetCardId);
    if (!target) {
      new Notice("The selected card no longer exists.");
      return;
    }
    if (this.sessionConflict) {
      new Notice("Resolve the external edit conflict before changing the card structure.");
      return;
    }
    if (kind === "child" && target.level >= 6) {
      new Notice("Markdown supports at most six heading levels; an H6 card cannot have a child.");
      return;
    }

    const previousData = this.data;
    const previousDocument = this.parsed;
    const previousSelectedCardId = this.selectedCardId;
    const previousCollapsedCardIds = new Set(this.collapsedCardIds);
    const previousCardHeights = new Map(this.cardHeights);
    let result: CardInsertionResult;

    try {
      result = insertCard(this.data, this.parsed, targetCardId, kind);
      const remappedCollapsedCardIds = new Set<string>();
      for (const cardId of this.collapsedCardIds) {
        const nextCardId = result.previousToNextCardIds.get(cardId);
        if (nextCardId) {
          remappedCollapsedCardIds.add(nextCardId);
        }
      }
      const remappedCardHeights = new Map<string, number>();
      for (const [cardId, height] of this.cardHeights) {
        const nextCardId = result.previousToNextCardIds.get(cardId);
        if (nextCardId) {
          remappedCardHeights.set(nextCardId, height);
        }
      }
      if (kind === "child") {
        const nextParentId = result.previousToNextCardIds.get(targetCardId);
        if (nextParentId) {
          remappedCollapsedCardIds.delete(nextParentId);
        }
      }

      this.data = result.text;
      this.parsed = result.document;
      this.selectedCardId = result.createdCardId;
      this.collapsedCardIds = remappedCollapsedCardIds;
      this.cardHeights = remappedCardHeights;
      this.session?.commit(this.data, this, "local");
      await this.save();
    } catch (error) {
      this.data = previousData;
      this.parsed = previousDocument;
      this.selectedCardId = previousSelectedCardId;
      this.collapsedCardIds = previousCollapsedCardIds;
      this.cardHeights = previousCardHeights;
      if (this.session?.text !== previousData) {
        this.session?.commit(previousData, this, "local");
      }
      await this.renderView();
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not create the card: ${message}`);
      return;
    }

    try {
      await this.renderView();
      await this.startEditing(result.createdCardId, true);
      this.animateViewportToCard(result.createdCardId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`The card was created, but its editor could not be opened: ${message}`);
      await this.renderView();
    }
  }

  private showHeadingJumpMenu(event: MouseEvent, card: CardNode, issue: LevelJumpIssue): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(`Line ${issue.line}: H${issue.currentLevel} follows H${issue.previousLevel}`)
        .setIcon("triangle-alert")
        .setDisabled(true)
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(`Move this branch to H${issue.expectedLevel}`)
        .setIcon("arrow-up")
        .onClick(() => void this.repairHeadingJump(card.id, issue, "promote"))
    );
    menu.addItem((item) =>
      item
        .setTitle(`Insert missing H${issue.expectedLevel} parent`)
        .setIcon("list-plus")
        .onClick(() => void this.repairHeadingJump(card.id, issue, "insert-parent"))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Open Markdown editor")
        .setIcon("file-text")
        .onClick(() => void this.switchToMarkdown())
    );
    menu.addItem((item) => item.setTitle("Keep as written").setIcon("check"));
    menu.showAtMouseEvent(event);
  }

  private async repairHeadingJump(
    cardId: string,
    issue: LevelJumpIssue,
    action: "promote" | "insert-parent"
  ): Promise<void> {
    if (this.editor) {
      await this.finishEditing(true);
    }
    if (this.sessionConflict) {
      new Notice("Resolve the external edit conflict before repairing the heading structure.");
      return;
    }

    const previousData = this.data;
    const previousDocument = this.parsed;
    const previousSelectedCardId = this.selectedCardId;
    const previousCollapsedCardIds = new Set(this.collapsedCardIds);
    const previousCardHeights = new Map(this.cardHeights);

    try {
      const result = action === "promote"
        ? promoteCardBranch(this.data, this.parsed, cardId, issue.expectedLevel)
        : insertMissingParent(this.data, this.parsed, cardId, issue.expectedLevel);
      this.applyHeadingRepair(result);
      await this.save();
      await this.renderView();
      if (action === "insert-parent") {
        await this.startEditing(result.selectedCardId, true);
        new Notice(`Inserted an H${issue.expectedLevel} parent. Give the new card a title.`);
      } else {
        new Notice(`Moved this branch from H${issue.currentLevel} to H${issue.expectedLevel}.`);
      }
    } catch (error) {
      this.data = previousData;
      this.parsed = previousDocument;
      this.selectedCardId = previousSelectedCardId;
      this.collapsedCardIds = previousCollapsedCardIds;
      this.cardHeights = previousCardHeights;
      if (this.session?.text !== previousData) {
        this.session?.commit(previousData, this, "local");
      }
      await this.renderView();
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not repair this heading jump: ${message}`);
    }
  }

  private applyHeadingRepair(result: HeadingRepairResult): void {
    const remappedCollapsedCardIds = new Set<string>();
    for (const cardId of this.collapsedCardIds) {
      const nextCardId = result.previousToNextCardIds.get(cardId);
      if (nextCardId) {
        remappedCollapsedCardIds.add(nextCardId);
      }
    }
    const remappedCardHeights = new Map<string, number>();
    for (const [cardId, height] of this.cardHeights) {
      const nextCardId = result.previousToNextCardIds.get(cardId);
      if (nextCardId) {
        remappedCardHeights.set(nextCardId, height);
      }
    }
    remappedCollapsedCardIds.delete(result.selectedCardId);
    this.data = result.text;
    this.parsed = result.document;
    this.selectedCardId = result.selectedCardId;
    this.collapsedCardIds = remappedCollapsedCardIds;
    this.cardHeights = remappedCardHeights;
    this.session?.commit(this.data, this, "local");
  }

  private updateSelectionPresentation(): void {
    const path = this.selectedPath();
    const activePathIds = new Set(path.map((card) => card.id));
    this.renderBreadcrumb(path);
    for (const element of this.contentEl.querySelectorAll<HTMLElement>(".visual-card-writer-card")) {
      const cardId = element.dataset.cardId;
      const card = cardId ? this.cardById(cardId) : null;
      if (!card || !cardId) {
        continue;
      }
      const emphasis = getCardEmphasis(card, this.selectedCardId, activePathIds);
      element.removeClass("is-selected", "is-active-path", "is-available", "is-next-choice", "is-deemphasized");
      element.addClass(`is-${emphasis}`);
      element.dataset.emphasis = emphasis;
      element.setAttribute("aria-selected", String(cardId === this.selectedCardId));
    }
  }

  private hasRenderedDocument(): boolean {
    return this.contentEl.querySelector(".visual-card-writer-columns, .visual-card-writer-hierarchy-guidance") != null;
  }

  private canPatchEditedCardInPlace(previous: CardDocument, next: CardDocument): boolean {
    if (previous.structure !== next.structure || previous.cards.length !== next.cards.length) {
      return false;
    }
    for (let index = 0; index < previous.cards.length; index += 1) {
      const before = previous.cards[index];
      const after = next.cards[index];
      if (
        before.id !== after.id ||
        before.kind !== after.kind ||
        before.level !== after.level ||
        before.depth !== after.depth ||
        before.parentId !== after.parentId ||
        before.children.join("\u0000") !== after.children.join("\u0000")
      ) {
        return false;
      }
    }
    return previous.roots.join("\u0000") === next.roots.join("\u0000") && !hasBlockingIssues(next);
  }

  private async renderCardBody(cardId: string): Promise<boolean> {
    const card = this.cardById(cardId);
    const body = this.cardBodyElement(cardId);
    if (!card || !body || !this.renderComponent) {
      return false;
    }
    body.empty();
    body.removeClass("visual-card-writer-editor-host");
    this.cardElement(cardId)?.removeClass("is-editing");
    try {
      await MarkdownRenderer.render(this.app, card.markdown, body, this.file?.path ?? "", this.renderComponent);
    } catch (error) {
      body.setText(card.markdown);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Visual Card Writer could not render ${card.id}: ${message}`);
    }
    return true;
  }

  private renderBreadcrumb(path: CardNode[]): void {
    let breadcrumb = this.contentEl.querySelector<HTMLElement>(".visual-card-writer-breadcrumb");
    if (!breadcrumb) {
      breadcrumb = this.contentEl.createDiv({ cls: "visual-card-writer-breadcrumb" });
    }
    breadcrumb.empty();
    for (let index = 0; index < path.length; index += 1) {
      const card = path[index];
      const button = breadcrumb.createEl("button", { text: card.title || "Untitled" });
      button.addEventListener("click", () => void this.selectCard(card.id));
      if (index < path.length - 1) {
        breadcrumb.createSpan({ text: ">" });
      }
    }
  }

  private finishRenderingCardLayout(generation: number): void {
    if (this.renderingCardLayoutGeneration === generation) {
      this.renderingCardLayoutGeneration = null;
    }
  }

  private waitForNextPaint(): Promise<void> {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(() => resolve(), milliseconds);
    });
  }

  private async expandAllCards(): Promise<void> {
    if (this.editor) {
      await this.finishEditing(true);
    }
    if (this.collapsedCardIds.size === 0) {
      return;
    }
    this.cancelCardTransition();
    this.collapsedCardIds.clear();
    await this.renderView(180);
  }

  private async collapseAllCards(): Promise<void> {
    if (this.editor) {
      await this.finishEditing(true);
    }
    const selectedRoot = this.rootCardIdForSelection();
    const transition = this.captureCardTransition(this.selectedCardId ?? selectedRoot ?? "");
    this.collapsedCardIds = new Set(getBranchCardIds(this.parsed.cards));
    this.selectedCardId = selectedRoot ?? this.parsed.roots[0] ?? null;
    await this.renderView();
    this.animateCardTransition(transition);
  }

  private rootCardIdForSelection(): string | null {
    let current = this.selectedCardId ? this.cardById(this.selectedCardId) : null;
    if (!current) {
      return this.parsed.roots[0] ?? null;
    }
    while (current.parentId) {
      const parent = this.cardById(current.parentId);
      if (!parent) {
        break;
      }
      current = parent;
    }
    return current.id;
  }

  private configureCardDrag(cardElement: HTMLElement, card: CardNode): void {
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let hasStartedDrag = false;
    const dragThreshold = 5;

    const isInteractiveTarget = (target: EventTarget | null): boolean => {
      return target instanceof Element && target.closest("button, a, input, textarea, select, .visual-card-writer-resize-handle, .cm-editor") != null;
    };

    const startPointerDrag = (event: PointerEvent): void => {
      hasStartedDrag = true;
      this.draggingCardId = card.id;
      this.lastDragClientX = event.clientX;
      this.lastDragClientY = event.clientY;
      this.containerEl.addClass("is-dragging-card");
      const viewport = cardElement.closest<HTMLElement>(".visual-card-writer-columns");
      if (viewport) {
        this.startDragWheelListener(viewport);
      }
      this.startDragVisualFeedback(cardElement, card, event.clientX, event.clientY);
      this.updateDropTargetFromDragPoint();
    };

    const finishPointerDrag = (event: PointerEvent, shouldDrop: boolean): void => {
      if (pointerId !== event.pointerId) {
        return;
      }
      const sourceCardId = this.draggingCardId;
      const dropTarget = shouldDrop ? this.dropTargetFromDragPoint() : null;
      const didDrag = hasStartedDrag;
      pointerId = null;
      hasStartedDrag = false;
      this.clearDragVisualFeedback();
      this.containerEl.removeClass("is-dragging-card");
      this.clearDragWheelState();
      if (cardElement.hasPointerCapture(event.pointerId)) {
        cardElement.releasePointerCapture(event.pointerId);
      }
      if (!didDrag) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.suppressNextCardClick = true;
      window.setTimeout(() => {
        this.suppressNextCardClick = false;
      }, 200);
      if (sourceCardId && dropTarget) {
        void this.moveCardByDrop(sourceCardId, dropTarget.cardId, dropTarget.placement);
        return;
      }
      this.draggingCardId = null;
      this.clearDropTarget();
    };

    cardElement.addEventListener("dragstart", (event) => event.preventDefault());
    cardElement.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary || isInteractiveTarget(event.target)) {
        return;
      }
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      hasStartedDrag = false;
      try {
        cardElement.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events do not always own a capturable pointer.
      }
    });
    cardElement.addEventListener("pointermove", (event) => {
      if (pointerId !== event.pointerId) {
        return;
      }
      if (!hasStartedDrag) {
        const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
        if (distance < dragThreshold) {
          return;
        }
        startPointerDrag(event);
      }
      event.preventDefault();
      this.rememberDragPointer(event);
      this.updateDragPreviewPosition(event.clientX, event.clientY);
      this.updateDropTargetFromDragPoint();
    });
    cardElement.addEventListener("pointerup", (event) => finishPointerDrag(event, true));
    cardElement.addEventListener("pointercancel", (event) => finishPointerDrag(event, false));
    cardElement.addEventListener("lostpointercapture", (event) => {
      if (pointerId === event.pointerId) {
        finishPointerDrag(event, false);
      }
    });
  }

  private startDragVisualFeedback(cardElement: HTMLElement, card: CardNode, clientX: number, clientY: number): void {
    this.clearDragVisualFeedback();
    const branch = this.parsed.structure === "headings" ? this.subtreeForCard(card.id) : [card];
    for (const branchCard of branch) {
      const element = this.cardElement(branchCard.id);
      if (!element) {
        continue;
      }
      element.addClass(branchCard.id === card.id ? "is-dragging" : "is-dragging-descendant");
      this.dragOriginElements.push(element);
    }

    const preview = cardElement.cloneNode(true) as HTMLElement;
    preview.removeAttribute("style");
    preview.removeAttribute("title");
    preview.removeAttribute("data-card-id");
    preview.removeAttribute("tabindex");
    preview.setAttribute("aria-hidden", "true");
    preview.removeClass(
      "is-selected",
      "is-active-path",
      "is-next-choice",
      "is-deemphasized",
      "is-dragging",
      "is-dragging-descendant",
      "is-drop-target"
    );
    preview.addClass("visual-card-writer-drag-preview");
    preview.querySelectorAll("button, .visual-card-writer-resize-handle").forEach((element) => element.remove());
    preview.querySelectorAll<HTMLElement>("a, [tabindex]").forEach((element) => element.setAttribute("tabindex", "-1"));
    const branchLabel = this.parsed.structure === "slides"
      ? "Moving slide"
      : branch.length > 1
        ? `Moving branch · ${branch.length} cards`
        : "Moving card";
    preview.createDiv({ cls: "visual-card-writer-drag-preview-label", text: branchLabel });
    const sourceRect = cardElement.getBoundingClientRect();
    preview.style.setProperty("--vcw-drag-preview-width", `${Math.min(Math.max(sourceRect.width, 220), 420)}px`);
    preview.style.setProperty("visibility", "hidden");
    document.body.appendChild(preview);
    this.dragPreviewElement = preview;
    this.updateDragPreviewPosition(clientX, clientY);
    preview.style.removeProperty("visibility");
  }

  private updateDragPreviewPosition(clientX: number, clientY: number): void {
    const preview = this.dragPreviewElement;
    if (!preview) {
      return;
    }
    const rect = preview.getBoundingClientRect();
    const position = getDragPreviewPosition(
      { x: clientX, y: clientY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    preview.style.setProperty("--vcw-drag-preview-x", `${position.x}px`);
    preview.style.setProperty("--vcw-drag-preview-y", `${position.y}px`);
  }

  private clearDragVisualFeedback(): void {
    for (const element of this.dragOriginElements) {
      element.removeClass("is-dragging", "is-dragging-descendant");
    }
    this.dragOriginElements = [];
    this.dragPreviewElement?.remove();
    this.dragPreviewElement = null;
  }

  private clearCardDragState(): void {
    this.clearDragVisualFeedback();
    this.containerEl.removeClass("is-dragging-card");
    this.clearDragWheelState();
    this.draggingCardId = null;
    this.clearDropTarget();
  }

  private dropPlacementForEvent(event: DragEvent, target: CardNode): CardMovePlacement {
    return this.dropPlacementForPoint(event.clientX, event.clientY, target);
  }

  private dropPlacementForPoint(clientX: number, clientY: number, target: CardNode): CardMovePlacement {
    const element = this.cardElement(target.id);
    if (!element) {
      return "after";
    }
    const rect = element.getBoundingClientRect();
    return getDropPlacementForPoint(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { x: clientX, y: clientY },
      this.layoutOrientation,
      this.parsed.structure === "headings"
    );
  }

  private rememberDragPointer(event: DragEvent | PointerEvent | WheelEvent): void {
    if (event.clientX === 0 && event.clientY === 0) {
      return;
    }
    this.lastDragClientX = event.clientX;
    this.lastDragClientY = event.clientY;
  }

  private updateDropTargetFromDragPoint(): void {
    const target = this.dropTargetFromDragPoint();
    if (!target) {
      this.scheduleDropTargetClear();
      return;
    }
    this.scheduleDropTarget(target.cardId, target.placement);
  }

  private dropTargetFromDragPoint(): { cardId: string; placement: CardMovePlacement } | null {
    if (!this.draggingCardId || this.lastDragClientX == null || this.lastDragClientY == null) {
      return null;
    }
    const element = document.elementFromPoint(this.lastDragClientX, this.lastDragClientY);
    const cardElement = element instanceof Element ? element.closest<HTMLElement>(".visual-card-writer-card") : null;
    const targetCardId = cardElement?.dataset.cardId;
    const target = targetCardId ? this.cardById(targetCardId) : null;
    if (!target) {
      return null;
    }
    const placement = this.dropPlacementForPoint(this.lastDragClientX, this.lastDragClientY, target);
    if (!this.canDropCard(this.draggingCardId, target.id, placement)) {
      return null;
    }
    return { cardId: target.id, placement };
  }

  private consumeSuppressedCardClick(event: MouseEvent): boolean {
    if (!this.suppressNextCardClick) {
      return false;
    }
    this.suppressNextCardClick = false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  private startDragWheelListener(viewport: HTMLElement): void {
    this.stopDragWheelListener();
    this.dragWheelViewport = viewport;
    this.dragWheelListener = (event) => {
      if (!this.draggingCardId || !this.dragWheelViewport || !this.dragWheelViewport.isConnected) {
        return;
      }
      const hasPointerCoordinates = event.clientX !== 0 || event.clientY !== 0;
      const clientX = hasPointerCoordinates ? event.clientX : this.lastDragClientX;
      const clientY = hasPointerCoordinates ? event.clientY : this.lastDragClientY;
      if (clientX != null && clientY != null) {
        const bounds = this.dragWheelViewport.getBoundingClientRect();
        if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) {
          return;
        }
        this.lastDragClientX = clientX;
        this.lastDragClientY = clientY;
        this.updateDragPreviewPosition(clientX, clientY);
      }
      event.preventDefault();
      event.stopPropagation();
      this.cancelViewportScrollAnimation();
      this.scheduleDragWheelScroll(this.dragWheelViewport, event);
    };
    window.addEventListener("wheel", this.dragWheelListener, { capture: true, passive: false });
  }

  private stopDragWheelListener(): void {
    if (this.dragWheelListener) {
      window.removeEventListener("wheel", this.dragWheelListener, true);
      this.dragWheelListener = null;
    }
    this.dragWheelViewport = null;
  }

  private clearDragWheelState(): void {
    this.stopDragWheelListener();
    if (this.dragWheelAnimationFrame != null) {
      window.cancelAnimationFrame(this.dragWheelAnimationFrame);
      this.dragWheelAnimationFrame = null;
    }
    this.pendingDragWheelDeltaX = 0;
    this.pendingDragWheelDeltaY = 0;
    this.lastDragClientX = null;
    this.lastDragClientY = null;
  }
  private canDropCard(sourceCardId: string, targetCardId: string, placement: CardMovePlacement): boolean {
    if (sourceCardId === targetCardId || this.sessionConflict || hasBlockingIssues(this.parsed)) {
      return false;
    }
    const source = this.cardById(sourceCardId);
    const target = this.cardById(targetCardId);
    if (!source || !target) {
      return false;
    }
    if (this.parsed.structure === "slides") {
      return placement !== "child";
    }
    if (this.isDescendantOf(targetCardId, sourceCardId)) {
      return false;
    }
    const nextSourceLevel = placement === "child" ? target.level + 1 : target.level;
    const levelDelta = nextSourceLevel - source.level;
    return this.subtreeForCard(sourceCardId).every((card) => {
      const level = card.level + levelDelta;
      return level >= 1 && level <= 6;
    });
  }

  private scheduleDropTarget(cardId: string, placement: CardMovePlacement): void {
    this.cancelDropTargetClear();
    if (this.dragTargetCardId === cardId) {
      this.dragPlacement = placement;
      this.cardElement(cardId)?.setAttribute("data-drop-placement", placement);
      return;
    }
    this.pendingDropTargetCardId = cardId;
    this.pendingDropPlacement = placement;
    if (this.pendingDropTargetTimer != null) {
      return;
    }
    this.pendingDropTargetTimer = window.setTimeout(() => {
      const nextCardId = this.pendingDropTargetCardId;
      const nextPlacement = this.pendingDropPlacement;
      this.pendingDropTargetTimer = null;
      this.pendingDropTargetCardId = null;
      this.pendingDropPlacement = null;
      if (nextCardId && nextPlacement) {
        this.setDropTarget(nextCardId, nextPlacement);
      }
    }, 55);
  }

  private setDropTarget(cardId: string, placement: CardMovePlacement): void {
    this.cancelDropTargetClear();
    if (this.dragTargetCardId === cardId) {
      this.dragPlacement = placement;
      this.cardElement(cardId)?.setAttribute("data-drop-placement", placement);
      return;
    }
    this.clearDropTarget();
    const element = this.cardElement(cardId);
    if (!element) {
      return;
    }
    this.dragTargetCardId = cardId;
    this.dragPlacement = placement;
    element.addClass("is-drop-target");
    element.setAttribute("data-drop-placement", placement);
  }

  private scheduleDropTargetClear(): void {
    this.cancelPendingDropTarget();
    if (this.dropTargetClearTimer != null) {
      return;
    }
    this.dropTargetClearTimer = window.setTimeout(() => {
      this.dropTargetClearTimer = null;
      this.clearDropTarget();
    }, 90);
  }

  private cancelPendingDropTarget(): void {
    if (this.pendingDropTargetTimer != null) {
      window.clearTimeout(this.pendingDropTargetTimer);
      this.pendingDropTargetTimer = null;
    }
    this.pendingDropTargetCardId = null;
    this.pendingDropPlacement = null;
  }

  private cancelDropTargetClear(): void {
    if (this.dropTargetClearTimer != null) {
      window.clearTimeout(this.dropTargetClearTimer);
      this.dropTargetClearTimer = null;
    }
  }

  private clearDropTarget(): void {
    this.cancelPendingDropTarget();
    this.cancelDropTargetClear();
    if (this.dragTargetCardId) {
      const element = this.cardElement(this.dragTargetCardId);
      element?.removeClass("is-drop-target", "is-drop-before", "is-drop-after", "is-drop-child");
      element?.removeAttribute("data-drop-placement");
    }
    this.dragTargetCardId = null;
    this.dragPlacement = null;
  }

  private async moveCardByDrop(sourceCardId: string, targetCardId: string, placement: CardMovePlacement): Promise<void> {
    if (this.editor) {
      await this.finishEditing(true);
    }
    const previousData = this.data;
    const previousDocument = this.parsed;
    const previousSelectedCardId = this.selectedCardId;
    const previousCollapsedCardIds = new Set(this.collapsedCardIds);
    const previousCardHeights = new Map(this.cardHeights);
    this.cancelCardTransition();
    try {
      const result = moveCard(this.data, this.parsed, sourceCardId, targetCardId, placement);
      this.data = result.text;
      this.parsed = result.document;
      this.selectedCardId = result.movedCardId;
      this.collapsedCardIds = this.remapCardIdSet(previousCollapsedCardIds, result.previousToNextCardIds);
      this.cardHeights = this.remapCardHeightMap(previousCardHeights, result.previousToNextCardIds);
      if (placement === "child") {
        const nextParentId = result.previousToNextCardIds.get(targetCardId);
        if (nextParentId) {
          this.collapsedCardIds.delete(nextParentId);
        }
      }
      this.session?.commit(this.data, this, "local");
      await this.save();
      await this.renderView();
      this.cardElement(result.movedCardId)?.focus({ preventScroll: true });
      this.animateViewportToCard(result.movedCardId);
    } catch (error) {
      this.cancelCardTransition();
      this.data = previousData;
      this.parsed = previousDocument;
      this.selectedCardId = previousSelectedCardId;
      this.collapsedCardIds = previousCollapsedCardIds;
      this.cardHeights = previousCardHeights;
      if (this.session?.text !== previousData) {
        this.session?.commit(previousData, this, "local");
      }
      await this.renderView();
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Could not move the card: ${message}`);
    } finally {
      this.clearCardDragState();
    }
  }

  private subtreeForCard(cardId: string): CardNode[] {
    const startIndex = this.parsed.cards.findIndex((card) => card.id === cardId);
    if (startIndex === -1) {
      return [];
    }
    const root = this.parsed.cards[startIndex];
    const result = [root];
    for (let index = startIndex + 1; index < this.parsed.cards.length; index += 1) {
      const card = this.parsed.cards[index];
      if (card.level <= root.level) {
        break;
      }
      result.push(card);
    }
    return result;
  }

  private remapCardIdSet(cardIds: ReadonlySet<string>, mapping: ReadonlyMap<string, string>): Set<string> {
    const result = new Set<string>();
    for (const cardId of cardIds) {
      const nextCardId = mapping.get(cardId);
      if (nextCardId) {
        result.add(nextCardId);
      }
    }
    return result;
  }

  private remapCardHeightMap(
    heights: ReadonlyMap<string, number>,
    mapping: ReadonlyMap<string, string>
  ): Map<string, number> {
    const result = new Map<string, number>();
    for (const [cardId, height] of heights) {
      const nextCardId = mapping.get(cardId);
      if (nextCardId) {
        result.set(nextCardId, height);
      }
    }
    return result;
  }
  private selectedPath(): CardNode[] {
    const path: CardNode[] = [];
    let current = this.selectedCardId ? this.cardById(this.selectedCardId) : null;
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.cardById(current.parentId) : null;
    }
    return path;
  }

  private editingCard(): CardNode | null {
    if (!this.editingCardId) {
      return null;
    }
    const original = this.cardById(this.editingCardId);
    if (!original) {
      return null;
    }
    return {
      ...original,
      range: { ...original.range, start: this.editingRangeStart, end: this.editingRangeEnd }
    };
  }

  private destroyEditor(): void {
    if (!this.editor) {
      return;
    }
    this.editor.destroy();
    this.editor = null;
    this.editingCardId = null;
    this.editingBaseMarkdown = "";
    this.editorDestroys += 1;
  }

  private isInsideActiveEditor(event: Event): boolean {
    const target = event.target;
    return this.editor != null && target instanceof Node && this.editor.dom.contains(target);
  }

  private handleViewClick(event: MouseEvent): void {
    if (event.button !== 0 || !this.editor) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest(".visual-card-writer-card")) {
      return;
    }
    void this.finishEditing(true);
  }

  private createCardResizeHandles(card: HTMLElement, cardId: string, depth: number): void {
    const horizontal = card.createDiv({
      cls: ["visual-card-writer-resize-handle", "is-horizontal"],
      attr: {
        role: "separator",
        tabindex: "0",
        "aria-orientation": "vertical",
        "aria-label": "Resize column width",
        "aria-valuemin": "160",
        "aria-valuemax": "1100",
        "aria-valuenow": String(Math.round(card.offsetWidth)),
        title: "Drag to resize every card in this column - Double-click to reset"
      }
    });
    const vertical = card.createDiv({
      cls: ["visual-card-writer-resize-handle", "is-vertical"],
      attr: {
        role: "separator",
        tabindex: "0",
        "aria-orientation": "horizontal",
        "aria-label": "Resize this card height",
        "aria-valuemin": "72",
        "aria-valuemax": "4000",
        "aria-valuenow": String(Math.round(card.offsetHeight)),
        title: "Drag to resize only this card - Double-click to reset"
      }
    });
    const corner = card.createDiv({
      cls: ["visual-card-writer-resize-handle", "is-corner"],
      attr: {
        "aria-hidden": "true",
        title: "Drag to resize column width and this card height"
      }
    });

    this.configureCardResizeHandle(horizontal, card, cardId, depth, true, false);
    this.configureCardResizeHandle(vertical, card, cardId, depth, false, true);
    this.configureCardResizeHandle(corner, card, cardId, depth, true, true);
  }

  private configureCardResizeHandle(
    handle: HTMLElement,
    card: HTMLElement,
    cardId: string,
    depth: number,
    resizeWidth: boolean,
    resizeHeight: boolean
  ): void {
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;
    let startScrollLeft = 0;
    let currentClientX = 0;
    let horizontalIntent = 0;
    let resizeViewport: HTMLElement | null = null;
    let autoScrollFrame: number | null = null;
    let previousAutoScrollTime: number | null = null;

    const stopAutoScroll = (): void => {
      if (autoScrollFrame != null) {
        window.cancelAnimationFrame(autoScrollFrame);
        autoScrollFrame = null;
      }
      previousAutoScrollTime = null;
    };

    const updateWidth = (): void => {
      if (!resizeWidth) {
        return;
      }
      const scrollDelta = (resizeViewport?.scrollLeft ?? startScrollLeft) - startScrollLeft;
      this.applyColumnWidth(
        depth,
        startWidth + resizeWorldDelta(currentClientX - startX, scrollDelta, this.zoomLevel)
      );
    };

    const continueAutoScroll = (timestamp: number): void => {
      autoScrollFrame = null;
      if (pointerId == null || !resizeWidth || !resizeViewport || horizontalIntent === 0) {
        return;
      }
      const bounds = resizeViewport.getBoundingClientRect();
      const velocity = edgeAutoScrollVelocity(currentClientX, bounds.left, bounds.right);
      if (velocity === 0 || Math.sign(velocity) !== horizontalIntent) {
        previousAutoScrollTime = null;
        return;
      }
      const elapsed = previousAutoScrollTime == null ? 1000 / 60 : Math.min(32, timestamp - previousAutoScrollTime);
      previousAutoScrollTime = timestamp;
      const previousScrollLeft = resizeViewport.scrollLeft;
      resizeViewport.scrollLeft += velocity * (elapsed / 1000);
      if (resizeViewport.scrollLeft !== previousScrollLeft) {
        updateWidth();
      }
      autoScrollFrame = window.requestAnimationFrame(continueAutoScroll);
    };

    const scheduleAutoScroll = (): void => {
      if (autoScrollFrame == null) {
        autoScrollFrame = window.requestAnimationFrame(continueAutoScroll);
      }
    };

    const finish = (event: PointerEvent): void => {
      if (pointerId !== event.pointerId) {
        return;
      }
      pointerId = null;
      stopAutoScroll();
      resizeViewport?.removeClass("is-resizing-column");
      handle.removeClass("is-resizing");
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.cancelViewportScrollAnimation();
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      currentClientX = event.clientX;
      horizontalIntent = 0;
      startWidth = card.offsetWidth;
      startHeight = card.offsetHeight;
      resizeViewport = this.contentEl.querySelector<HTMLElement>(".visual-card-writer-columns");
      startScrollLeft = resizeViewport?.scrollLeft ?? 0;
      resizeViewport?.addClass("is-resizing-column");
      handle.addClass("is-resizing");
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events do not always own a capturable pointer.
      }
    });
    handle.addEventListener("pointermove", (event) => {
      if (pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const pointerMovement = event.clientX - currentClientX;
      if (pointerMovement !== 0) {
        horizontalIntent = Math.sign(pointerMovement);
      }
      currentClientX = event.clientX;
      if (resizeWidth) {
        updateWidth();
        scheduleAutoScroll();
      }
      if (resizeHeight) {
        this.applyCardHeight(cardId, startHeight + (event.clientY - startY) / this.zoomLevel);
      }
    });
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", (event) => {
      if (pointerId === event.pointerId) {
        pointerId = null;
        stopAutoScroll();
        resizeViewport?.removeClass("is-resizing-column");
        handle.removeClass("is-resizing");
      }
    });
    handle.addEventListener("click", (event) => event.stopPropagation());
    handle.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (resizeWidth) {
        this.resetColumnWidth(depth);
      }
      if (resizeHeight) {
        this.resetCardHeight(cardId);
      }
    });
    handle.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 60 : 20;
      let handled = false;
      if (resizeWidth && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        this.applyColumnWidth(depth, card.offsetWidth + (event.key === "ArrowRight" ? step : -step));
        handled = true;
      }
      if (resizeHeight && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        this.applyCardHeight(cardId, card.offsetHeight + (event.key === "ArrowDown" ? step : -step));
        handled = true;
      }
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
  }

  private applyColumnWidth(depth: number, requestedWidth: number): void {
    const viewport = this.contentEl.querySelector<HTMLElement>(".visual-card-writer-columns");
    const maximumWidth = Math.min(1100, Math.max(160, (viewport?.clientWidth ?? 1152) / this.zoomLevel - 52));
    const minimumWidth = Math.min(320, maximumWidth);
    const width = Math.round(Math.min(maximumWidth, Math.max(minimumWidth, requestedWidth)));
    this.columnWidths.set(depth, width);
    const column = this.contentEl.querySelector<HTMLElement>(`.visual-card-writer-column[data-depth="${depth}"]`);
    if (!column) {
      return;
    }
    column.style.setProperty("--vcw-column-width", `${width}px`);
    for (const card of column.querySelectorAll<HTMLElement>(".visual-card-writer-card")) {
      card.querySelector<HTMLElement>(".visual-card-writer-resize-handle.is-horizontal")?.setAttribute(
        "aria-valuenow",
        String(width)
      );
    }
    this.scheduleCardLayout();
  }

  private resetColumnWidth(depth: number): void {
    this.columnWidths.delete(depth);
    const column = this.contentEl.querySelector<HTMLElement>(`.visual-card-writer-column[data-depth="${depth}"]`);
    if (!column) {
      return;
    }
    column.style.removeProperty("--vcw-column-width");
    for (const card of column.querySelectorAll<HTMLElement>(".visual-card-writer-card")) {
      card.querySelector<HTMLElement>(".visual-card-writer-resize-handle.is-horizontal")?.setAttribute(
        "aria-valuenow",
        String(Math.round(card.offsetWidth))
      );
    }
    this.scheduleCardLayout();
  }

  private applyCardHeight(cardId: string, requestedHeight: number): void {
    const height = Math.round(Math.min(4000, Math.max(72, requestedHeight)));
    this.cardHeights.set(cardId, height);
    const card = this.cardElement(cardId);
    if (!card) {
      return;
    }
    card.style.setProperty("--vcw-card-height", `${height}px`);
    card.querySelector<HTMLElement>(".visual-card-writer-resize-handle.is-vertical")?.setAttribute(
      "aria-valuenow",
      String(height)
    );
    this.scheduleCardLayout();
  }

  private resetCardHeight(cardId: string): void {
    this.cardHeights.delete(cardId);
    const card = this.cardElement(cardId);
    if (!card) {
      return;
    }
    card.style.removeProperty("--vcw-card-height");
    card.querySelector<HTMLElement>(".visual-card-writer-resize-handle.is-vertical")?.setAttribute(
      "aria-valuenow",
      String(Math.round(card.offsetHeight))
    );
    this.scheduleCardLayout();
  }

  private animateViewportToCard(cardId: string): void {
    const viewport = this.contentEl.querySelector<HTMLElement>(".visual-card-writer-columns");
    const card = this.cardElement(cardId);
    if (!viewport || !card) {
      return;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const targetLeft = centeredScrollOffset(
      viewport.scrollLeft,
      viewportRect.left,
      viewport.clientWidth,
      cardRect.left,
      cardRect.width,
      viewport.scrollWidth - viewport.clientWidth
    );
    const targetTop = centeredScrollOffset(
      viewport.scrollTop,
      viewportRect.top,
      viewport.clientHeight,
      cardRect.top,
      cardRect.height,
      viewport.scrollHeight - viewport.clientHeight
    );
    const startLeft = viewport.scrollLeft;
    const startTop = viewport.scrollTop;
    const deltaLeft = targetLeft - startLeft;
    const deltaTop = targetTop - startTop;
    const distance = Math.hypot(deltaLeft, deltaTop);
    if (distance < 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      viewport.scrollLeft = targetLeft;
      viewport.scrollTop = targetTop;
      return;
    }

    const duration = scrollAnimationDuration(distance);
    const startedAt = window.performance.now();
    const step = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      viewport.scrollLeft = startLeft + deltaLeft * eased;
      viewport.scrollTop = startTop + deltaTop * eased;
      if (progress < 1) {
        this.viewportScrollAnimationFrame = window.requestAnimationFrame(step);
      } else {
        this.viewportScrollAnimationFrame = null;
        viewport.scrollLeft = targetLeft;
        viewport.scrollTop = targetTop;
      }
    };
    this.viewportScrollAnimationFrame = window.requestAnimationFrame(step);
  }

  private cancelViewportScrollAnimation(): void {
    if (this.viewportScrollAnimationFrame != null) {
      window.cancelAnimationFrame(this.viewportScrollAnimationFrame);
      this.viewportScrollAnimationFrame = null;
    }
  }

  private configureViewport(viewport: HTMLElement): void {
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;
    let pendingX = 0;
    let pendingY = 0;
    let panAnimationFrame: number | null = null;

    const applyPendingPan = (): void => {
      panAnimationFrame = null;
      viewport.scrollLeft = startScrollLeft - (pendingX - startX);
      viewport.scrollTop = startScrollTop - (pendingY - startY);
    };

    const cancelPendingPan = (): void => {
      if (panAnimationFrame != null) {
        window.cancelAnimationFrame(panAnimationFrame);
        panAnimationFrame = null;
      }
    };

    const finishPan = (event: PointerEvent): void => {
      if (pointerId !== event.pointerId) {
        return;
      }
      if (panAnimationFrame != null) {
        cancelPendingPan();
        applyPendingPan();
      }
      pointerId = null;
      viewport.removeClass("is-panning");
      if (viewport.hasPointerCapture(event.pointerId)) {
        viewport.releasePointerCapture(event.pointerId);
      }
    };

    viewport.addEventListener("pointerdown", (event) => {
      this.cancelViewportScrollAnimation();
      if (event.button !== 1) {
        return;
      }
      event.preventDefault();
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      pendingX = event.clientX;
      pendingY = event.clientY;
      startScrollLeft = viewport.scrollLeft;
      startScrollTop = viewport.scrollTop;
      viewport.addClass("is-panning");
      try {
        viewport.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events do not always own a capturable pointer.
      }
    });
    viewport.addEventListener("pointermove", (event) => {
      if (pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      pendingX = event.clientX;
      pendingY = event.clientY;
      if (panAnimationFrame == null) {
        panAnimationFrame = window.requestAnimationFrame(applyPendingPan);
      }
    });
    viewport.addEventListener("pointerup", finishPan);
    viewport.addEventListener("pointercancel", finishPan);
    viewport.addEventListener("lostpointercapture", (event) => {
      if (pointerId === event.pointerId) {
        cancelPendingPan();
        pointerId = null;
        viewport.removeClass("is-panning");
      }
    });
    viewport.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    });
    viewport.addEventListener(
      "wheel",
      (event) => {
        this.cancelViewportScrollAnimation();
        if (this.draggingCardId) {
          event.preventDefault();
          this.rememberDragPointer(event);
          this.scheduleDragWheelScroll(viewport, event);
          return;
        }
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          const nextZoom = zoomFromWheel(this.zoomLevel, event.deltaY);
          const bounds = viewport.getBoundingClientRect();
          this.setZoomAtViewportPoint(nextZoom, viewport, event.clientX - bounds.left, event.clientY - bounds.top);
          return;
        }
        if (event.shiftKey) {
          const delta = this.normalizedWheelDelta(event, viewport);
          if (Math.abs(delta.y) > Math.abs(delta.x)) {
            event.preventDefault();
            viewport.scrollLeft += delta.y;
          }
        }
      },
      { passive: false }
    );
  }

  private normalizedWheelDelta(event: WheelEvent, viewport: HTMLElement): { x: number; y: number } {
    let multiplier = 1;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      multiplier = 40;
    } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      multiplier = Math.max(1, viewport.clientHeight);
    }
    return {
      x: event.deltaX * multiplier,
      y: event.deltaY * multiplier
    };
  }

  private scheduleDragWheelScroll(viewport: HTMLElement, event: WheelEvent): void {
    const delta = this.normalizedWheelDelta(event, viewport);
    const useVerticalWheelForHorizontalScroll = event.shiftKey && Math.abs(delta.y) >= Math.abs(delta.x);
    this.pendingDragWheelDeltaX += useVerticalWheelForHorizontalScroll ? delta.y : delta.x;
    this.pendingDragWheelDeltaY += useVerticalWheelForHorizontalScroll ? 0 : delta.y;
    if (this.dragWheelAnimationFrame != null) {
      return;
    }
    this.dragWheelAnimationFrame = window.requestAnimationFrame(() => {
      this.dragWheelAnimationFrame = null;
      const deltaX = this.pendingDragWheelDeltaX;
      const deltaY = this.pendingDragWheelDeltaY;
      this.pendingDragWheelDeltaX = 0;
      this.pendingDragWheelDeltaY = 0;
      const previousLeft = viewport.scrollLeft;
      const previousTop = viewport.scrollTop;
      viewport.scrollLeft += deltaX;
      viewport.scrollTop += deltaY;
      if (viewport.scrollLeft !== previousLeft || viewport.scrollTop !== previousTop) {
        this.updateDropTargetFromDragPoint();
      }
    });
  }
  private setZoomAtViewportPoint(
    nextZoom: number,
    viewport: HTMLElement,
    pointerX: number,
    pointerY: number
  ): void {
    if (nextZoom === this.zoomLevel) {
      return;
    }
    const style = window.getComputedStyle(viewport);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const previousZoom = this.zoomLevel;
    const nextScrollLeft = anchoredScrollOffset(
      viewport.scrollLeft,
      pointerX,
      paddingLeft,
      previousZoom,
      nextZoom
    );
    const nextScrollTop = anchoredScrollOffset(
      viewport.scrollTop,
      pointerY,
      paddingTop,
      previousZoom,
      nextZoom
    );
    this.zoomLevel = nextZoom;
    this.applyZoomGeometry(viewport);
    viewport.scrollLeft = nextScrollLeft;
    viewport.scrollTop = nextScrollTop;
  }

  private applyZoomGeometry(viewport: HTMLElement): void {
    const scene = viewport.querySelector<HTMLElement>(".visual-card-writer-scene");
    const surface = viewport.querySelector<HTMLElement>(".visual-card-writer-surface");
    if (!scene || !surface) {
      return;
    }
    const worldWidth = Number.parseFloat(scene.dataset.worldWidth ?? "0");
    const worldHeight = Number.parseFloat(scene.dataset.worldHeight ?? "0");
    surface.style.setProperty("--vcw-zoom", String(this.zoomLevel));
    scene.style.setProperty("--vcw-scene-width", `${Math.ceil(worldWidth * this.zoomLevel)}px`);
    scene.style.setProperty("--vcw-scene-height", `${Math.ceil(worldHeight * this.zoomLevel)}px`);
    const zoomButton = this.contentEl.querySelector<HTMLElement>(".visual-card-writer-zoom-indicator");
    zoomButton?.setText(`${Math.round(this.zoomLevel * 100)}%`);
  }

  private captureCardTransition(triggerId: string): CardTransitionSnapshot | null {
    this.cancelCardTransition();
    const viewport = this.contentEl.querySelector<HTMLElement>(".visual-card-writer-columns");
    const trigger = this.cardElement(triggerId);
    if (!viewport || !trigger) {
      return null;
    }

    const items: CardTransitionItem[] = [];
    for (const element of viewport.querySelectorAll<HTMLElement>(".visual-card-writer-card")) {
      const id = element.dataset.cardId;
      if (!id) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const opacity = Number.parseFloat(window.getComputedStyle(element).opacity) || 1;
      const ghost = element.cloneNode(true) as HTMLElement;
      ghost.addClass("visual-card-writer-transition-ghost");
      ghost.setAttribute("aria-hidden", "true");
      ghost.removeAttribute("tabindex");
      for (const interactive of ghost.querySelectorAll<HTMLElement>("button, a, input, textarea, [tabindex]")) {
        interactive.setAttribute("tabindex", "-1");
      }
      ghost.style.setProperty("--vcw-ghost-top", `${rect.top}px`);
      ghost.style.setProperty("--vcw-ghost-left", `${rect.left}px`);
      ghost.style.setProperty("--vcw-ghost-width", `${rect.width}px`);
      ghost.style.setProperty("--vcw-ghost-height", `${rect.height}px`);
      ghost.style.setProperty("--vcw-ghost-opacity", String(opacity));
      if (!this.cardTransitionOverlay) {
        const viewportRect = viewport.getBoundingClientRect();
        this.cardTransitionOverlay = document.body.createDiv({ cls: "visual-card-writer-transition-overlay" });
        this.cardTransitionOverlay.style.setProperty("--vcw-overlay-top", `${viewportRect.top}px`);
        this.cardTransitionOverlay.style.setProperty("--vcw-overlay-left", `${viewportRect.left}px`);
        this.cardTransitionOverlay.style.setProperty("--vcw-overlay-width", `${viewportRect.width}px`);
        this.cardTransitionOverlay.style.setProperty("--vcw-overlay-height", `${viewportRect.height}px`);
      }
      const viewportRect = viewport.getBoundingClientRect();
      ghost.style.setProperty("--vcw-ghost-top", `${rect.top - viewportRect.top}px`);
      ghost.style.setProperty("--vcw-ghost-left", `${rect.left - viewportRect.left}px`);
      this.cardTransitionOverlay.appendChild(ghost);
      this.cardTransitionGhosts.push(ghost);
      items.push({ id, rect, opacity, ghost });
    }
    this.containerEl.addClass("is-layout-transitioning");
    return {
      token: this.cardTransitionToken,
      triggerId,
      triggerRect: trigger.getBoundingClientRect(),
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      items
    };
  }

  private animateCardTransition(snapshot: CardTransitionSnapshot | null): void {
    if (!snapshot || snapshot.token !== this.cardTransitionToken) {
      return;
    }
    const viewport = this.contentEl.querySelector<HTMLElement>(".visual-card-writer-columns");
    const trigger = this.cardElement(snapshot.triggerId);
    if (!viewport || !trigger || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.finishCardTransition(snapshot.token);
      return;
    }

    viewport.scrollLeft = snapshot.scrollLeft;
    viewport.scrollTop = snapshot.scrollTop;
    const triggerRect = trigger.getBoundingClientRect();
    viewport.scrollLeft += triggerRect.left - snapshot.triggerRect.left;
    viewport.scrollTop += triggerRect.top - snapshot.triggerRect.top;

    const previousIds = new Set(snapshot.items.map((item) => item.id));
    const destinationRects = new Map<string, DOMRect>();
    let maximumTravel = 0;
    for (const item of snapshot.items) {
      const destination = this.cardElement(item.id);
      if (!destination) {
        continue;
      }
      const rect = destination.getBoundingClientRect();
      destinationRects.set(item.id, rect);
      maximumTravel = Math.max(maximumTravel, Math.hypot(rect.left - item.rect.left, rect.top - item.rect.top));
    }
    const duration = Math.round(Math.min(430, 240 + maximumTravel * 0.18));
    const timing: KeyframeAnimationOptions = {
      duration,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "both"
    };

    for (const item of snapshot.items) {
      if (item.id === snapshot.triggerId) {
        item.ghost.remove();
        continue;
      }
      const destination = this.cardElement(item.id);
      const destinationRect = destinationRects.get(item.id);
      if (destination && destinationRect) {
        destination.addClass("is-transition-destination-hidden");
        this.cardTransitionHiddenElements.push(destination);
        const translateX = destinationRect.left - item.rect.left;
        const translateY = destinationRect.top - item.rect.top;
        const scaleX = item.rect.width > 0 ? destinationRect.width / item.rect.width : 1;
        const scaleY = item.rect.height > 0 ? destinationRect.height / item.rect.height : 1;
        this.cardTransitionAnimations.push(
          item.ghost.animate(
            [
              { transform: "translate(0, 0) scale(1, 1)", opacity: item.opacity },
              {
                transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`,
                opacity: item.opacity
              }
            ],
            timing
          )
        );
      } else {
        this.cardTransitionAnimations.push(
          item.ghost.animate(
            [
              { transform: "translate(0, 0) scale(1)", opacity: item.opacity },
              { transform: "translate(-20px, 0) scale(0.98)", opacity: 0 }
            ],
            { ...timing, duration: Math.min(duration, 300) }
          )
        );
      }
    }

    for (const destination of viewport.querySelectorAll<HTMLElement>(".visual-card-writer-card")) {
      const id = destination.dataset.cardId;
      if (!id || previousIds.has(id)) {
        continue;
      }
      const targetOpacity = Number.parseFloat(window.getComputedStyle(destination).opacity) || 1;
      this.cardTransitionAnimations.push(
        destination.animate(
          [
            { transform: "translate(-18px, 0) scale(0.985)", opacity: 0 },
            { transform: "translate(0, 0) scale(1)", opacity: targetOpacity }
          ],
          { ...timing, delay: 35 }
        )
      );
    }

    if (this.cardTransitionAnimations.length === 0) {
      this.finishCardTransition(snapshot.token);
      return;
    }
    let remainingAnimations = this.cardTransitionAnimations.length;
    const animationEnded = (): void => {
      remainingAnimations -= 1;
      if (remainingAnimations === 0) {
        this.finishCardTransition(snapshot.token);
      }
    };
    for (const animation of this.cardTransitionAnimations) {
      animation.addEventListener("finish", animationEnded, { once: true });
      animation.addEventListener("cancel", animationEnded, { once: true });
    }
    this.cardTransitionCleanupTimer = window.setTimeout(() => {
      this.finishCardTransition(snapshot.token);
    }, duration + 250);
  }

  private finishCardTransition(token: number): void {
    if (token !== this.cardTransitionToken) {
      return;
    }
    const animations = this.cardTransitionAnimations;
    this.cardTransitionAnimations = [];
    for (const animation of animations) {
      animation.cancel();
    }
    for (const element of this.cardTransitionHiddenElements) {
      element.removeClass("is-transition-destination-hidden");
    }
    for (const ghost of this.cardTransitionGhosts) {
      ghost.remove();
    }
    if (this.cardTransitionCleanupTimer != null) {
      window.clearTimeout(this.cardTransitionCleanupTimer);
      this.cardTransitionCleanupTimer = null;
    }
    this.cardTransitionGhosts = [];
    this.cardTransitionHiddenElements = [];
    this.containerEl.removeClass("is-layout-transitioning");
  }

  private cancelCardTransition(): void {
    this.cardTransitionToken += 1;
    if (this.cardTransitionCleanupTimer != null) {
      window.clearTimeout(this.cardTransitionCleanupTimer);
      this.cardTransitionCleanupTimer = null;
    }
    for (const animation of this.cardTransitionAnimations) {
      animation.cancel();
    }
    for (const element of this.cardTransitionHiddenElements) {
      element.removeClass("is-transition-destination-hidden");
    }
    for (const ghost of this.cardTransitionGhosts) {
      ghost.remove();
    }
    this.cardTransitionAnimations = [];
    this.cardTransitionGhosts = [];
    this.cardTransitionHiddenElements = [];
    this.containerEl.removeClass("is-layout-transitioning");
  }

  private scheduleCardLayout(): void {
    if (this.renderingCardLayoutGeneration != null || this.layoutAnimationFrame != null) {
      return;
    }
    this.layoutAnimationFrame = window.requestAnimationFrame(() => {
      this.layoutAnimationFrame = null;
      this.layoutCards();
    });
  }

  private layoutCards(reveal = true): void {
    const columnsElement = this.contentEl.querySelector<HTMLElement>(".visual-card-writer-columns");
    if (!columnsElement) {
      return;
    }
    const visibleCards = getVisibleCards(this.parsed.cards, this.collapsedCardIds);
    const cardElements = new Map<string, HTMLElement>();
    for (const card of visibleCards) {
      const element = this.cardElement(card.id);
      if (element) {
        cardElements.set(card.id, element);
      }
    }
    const gap = 12;
    const cardDimensions = new Map(
      [...cardElements].map(([id, element]) => [
        id,
        { width: element.offsetWidth, height: element.offsetHeight }
      ])
    );
    const layout = computeBranchAxisLayout(
      visibleCards,
      this.parsed.roots,
      cardDimensions,
      gap,
      this.layoutOrientation
    );
    for (const card of visibleCards) {
      const element = cardElements.get(card.id);
      const offset = layout.tops.get(card.id);
      if (element && offset != null) {
        element.style.setProperty(
          this.layoutOrientation === "horizontal" ? "--vcw-card-top" : "--vcw-card-left",
          `${Math.round(offset)}px`
        );
      }
    }
    const columnElements = [...columnsElement.querySelectorAll<HTMLElement>(".visual-card-writer-column")];
    const surface = columnsElement.querySelector<HTMLElement>(".visual-card-writer-surface");
    const scene = columnsElement.querySelector<HTMLElement>(".visual-card-writer-scene");
    if (surface && scene) {
      const surfaceStyle = window.getComputedStyle(surface);
      let surfaceWidth: number;
      let surfaceHeight: number;
      let sceneWidth: number;
      let sceneHeight: number;
      if (this.layoutOrientation === "horizontal") {
        for (const column of columnElements) {
          const cards = [...column.querySelectorAll<HTMLElement>(".visual-card-writer-card")];
          const width = cards.reduce((maximum, card) => Math.max(maximum, card.offsetWidth), 0);
          column.style.setProperty("--vcw-layout-column-width", `${Math.ceil(width)}px`);
          column.style.setProperty("--vcw-column-height", `${Math.ceil(layout.totalHeight)}px`);
        }
        const columnGap = Number.parseFloat(surfaceStyle.columnGap) || 0;
        surfaceWidth =
          columnElements.reduce((total, column) => total + column.offsetWidth, 0) +
          Math.max(0, columnElements.length - 1) * columnGap;
        surfaceHeight = layout.totalHeight;
        const trailingWorkspaceWidth = Math.max(
          240,
          Math.min(480, (columnsElement.clientWidth / this.zoomLevel) * 0.4)
        );
        sceneWidth = surfaceWidth + trailingWorkspaceWidth;
        sceneHeight = surfaceHeight;
      } else {
        for (const row of columnElements) {
          const cards = [...row.querySelectorAll<HTMLElement>(".visual-card-writer-card")];
          const height = cards.reduce((maximum, card) => Math.max(maximum, card.offsetHeight), 0);
          row.style.setProperty("--vcw-row-width", `${Math.ceil(layout.totalHeight)}px`);
          row.style.setProperty("--vcw-row-height", `${Math.ceil(height)}px`);
        }
        const rowGap = Number.parseFloat(surfaceStyle.rowGap) || 0;
        surfaceWidth = layout.totalHeight;
        surfaceHeight =
          columnElements.reduce((total, row) => total + row.offsetHeight, 0) +
          Math.max(0, columnElements.length - 1) * rowGap;
        const trailingWorkspaceHeight = Math.max(
          240,
          Math.min(480, (columnsElement.clientHeight / this.zoomLevel) * 0.4)
        );
        sceneWidth = surfaceWidth;
        sceneHeight = surfaceHeight + trailingWorkspaceHeight;
      }
      surface.style.setProperty("--vcw-surface-width", `${Math.ceil(surfaceWidth)}px`);
      surface.style.setProperty("--vcw-surface-height", `${Math.ceil(surfaceHeight)}px`);
      this.renderChildConnectors(surface, visibleCards, surfaceWidth, surfaceHeight);
      scene.dataset.worldWidth = String(sceneWidth);
      scene.dataset.worldHeight = String(sceneHeight);
      this.applyZoomGeometry(columnsElement);
    }
    if (reveal) {
      columnsElement.addClass("is-laid-out");
    }
  }

  private stopCardLayout(): void {
    this.layoutResizeObserver?.disconnect();
    this.layoutResizeObserver = null;
    if (this.layoutAnimationFrame != null) {
      window.cancelAnimationFrame(this.layoutAnimationFrame);
      this.layoutAnimationFrame = null;
    }
  }

  private createOrientationToggle(parent: HTMLElement): void {
    const horizontal = this.layoutOrientation === "horizontal";
    const label = horizontal ? "Horizontal" : "Vertical";
    const nextLabel = horizontal ? "Vertical" : "Horizontal";
    const button = parent.createEl("button", {
      cls: "visual-card-writer-orientation-toggle",
      attr: {
        "aria-label": `${label} card layout. Switch to ${nextLabel}`,
        title: `Current layout: ${label} · Switch to ${nextLabel}`
      }
    });
    setIcon(button.createSpan({ cls: "visual-card-writer-orientation-icon" }), horizontal ? "columns-3" : "rows-3");
    button.createSpan({ cls: "visual-card-writer-orientation-label", text: label });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.toggleLayoutOrientation();
    });
  }

  private createFocusDimmingToggle(parent: HTMLElement): void {
    const button = parent.createEl("button", {
      cls: ["visual-card-writer-toolbar-button", "clickable-icon"]
    });
    this.focusDimmingButton = button;
    this.updateFocusDimmingButton();
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.toggleFocusDimming();
    });
  }

  private updateFocusDimmingButton(): void {
    const button = this.focusDimmingButton;
    if (!button) {
      return;
    }
    const enabled = this.focusDimmingEnabled;
    const label = enabled ? "Disable branch focus" : "Enable branch focus";
    button.empty();
    button.toggleClass("is-active", enabled);
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("title", enabled ? "Branch focus on - Dim unrelated cards" : "Branch focus off - Show all cards equally");
    setIcon(button, enabled ? "focus" : "eye");
  }

  private renderChildConnectors(
    surface: HTMLElement,
    visibleCards: CardNode[],
    surfaceWidth: number,
    surfaceHeight: number
  ): void {
    surface.querySelector(".visual-card-writer-connectors")?.remove();
    const byId = new Map(visibleCards.map((card) => [card.id, card]));
    const families = visibleCards
      .map((parent) => ({
        parent,
        children: parent.children.map((childId) => byId.get(childId)).filter((child) => child != null)
      }))
      .filter((family) => family.children.length > 0);
    if (families.length === 0) {
      return;
    }

    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.classList.add("visual-card-writer-connectors");
    svg.setAttribute("width", String(Math.ceil(surfaceWidth)));
    svg.setAttribute("height", String(Math.ceil(surfaceHeight)));
    svg.setAttribute("viewBox", `0 0 ${Math.ceil(surfaceWidth)} ${Math.ceil(surfaceHeight)}`);
    svg.setAttribute("aria-hidden", "true");

    for (const { parent, children } of families) {
      const parentElement = this.cardElement(parent.id);
      const parentGroup = parentElement?.parentElement;
      const childElements = children
        .map((child) => this.cardElement(child.id))
        .filter((element) => element != null);
      if (!parentElement || !parentGroup || childElements.length === 0) {
        continue;
      }
      const geometry = getOrthogonalConnectorGeometry(
        {
          left: parentGroup.offsetLeft + parentElement.offsetLeft,
          top: parentGroup.offsetTop + parentElement.offsetTop,
          width: parentElement.offsetWidth,
          height: parentElement.offsetHeight
        },
        childElements.map((childElement) => ({
          left: childElement.parentElement!.offsetLeft + childElement.offsetLeft,
          top: childElement.parentElement!.offsetTop + childElement.offsetTop,
          width: childElement.offsetWidth,
          height: childElement.offsetHeight
        })),
        this.layoutOrientation
      );
      const connector = document.createElementNS(namespace, "g");
      connector.classList.add("visual-card-writer-connector");
      connector.dataset.emphasis = parentElement.dataset.emphasis ?? "deemphasized";

      const line = document.createElementNS(namespace, "path");
      line.classList.add("visual-card-writer-connector-line");
      line.setAttribute("d", geometry.path);
      connector.appendChild(line);

      for (const tip of geometry.arrowTips) {
        const arrow = document.createElementNS(namespace, "path");
        arrow.classList.add("visual-card-writer-connector-arrow");
        arrow.setAttribute(
          "d",
          this.layoutOrientation === "horizontal"
            ? `M ${tip.x} ${tip.y} L ${tip.x - 6} ${tip.y - 4} L ${tip.x - 6} ${tip.y + 4} Z`
            : `M ${tip.x} ${tip.y} L ${tip.x - 4} ${tip.y - 6} L ${tip.x + 4} ${tip.y - 6} Z`
        );
        connector.appendChild(arrow);
      }
      svg.appendChild(connector);
    }
    surface.prepend(svg);
  }

  private applyLayoutOrientationClass(): void {
    this.containerEl.toggleClass("is-layout-horizontal", this.layoutOrientation === "horizontal");
    this.containerEl.toggleClass("is-layout-vertical", this.layoutOrientation === "vertical");
  }

  private bindSession(path: string, initialText: string): void {
    this.unbindSession();
    this.session = this.sessions.acquire(path, initialText);
    this.sessionPath = path;
    this.unsubscribeSession = this.session.subscribe((snapshot) => {
      if (snapshot.source !== this) {
        this.receiveSessionSnapshot(snapshot, false);
      }
    });
  }

  private unbindSession(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    if (this.sessionPath) {
      this.sessions.release(this.sessionPath);
    }
    this.session = null;
    this.sessionPath = null;
  }

  private receiveSessionSnapshot(snapshot: SessionSnapshot, includeOwnSource: boolean): void {
    if (!includeOwnSource && snapshot.source === this) {
      return;
    }
    if (!this.editor || !this.editingCardId) {
      this.applyDocumentText(snapshot.text);
      return;
    }

    const previous = this.editingCard();
    const next = parseCardDocument(snapshot.text);
    const nextCard = previous ? reconcileCard(previous, next) : null;
    if (!nextCard) {
      this.markSessionConflict(snapshot);
      return;
    }

    const localFragment = this.editor.state.doc.toString();
    if (nextCard.markdown === this.editingBaseMarkdown) {
      this.data = snapshot.text;
      this.parsed = next;
      this.selectedCardId = nextCard.id;
      this.editingCardId = nextCard.id;
      this.editingRangeStart = nextCard.range.start;
      this.editingRangeEnd = nextCard.range.end;
      return;
    }

    if (localFragment === this.editingBaseMarkdown) {
      this.data = snapshot.text;
      this.parsed = next;
      this.selectedCardId = nextCard.id;
      this.editingCardId = nextCard.id;
      this.editingRangeStart = nextCard.range.start;
      this.editingRangeEnd = nextCard.range.end;
      this.editingBaseMarkdown = nextCard.markdown;
      this.applyingSessionUpdate = true;
      try {
        this.editor.dispatch({
          changes: { from: 0, to: this.editor.state.doc.length, insert: nextCard.markdown }
        });
      } finally {
        this.applyingSessionUpdate = false;
      }
      return;
    }

    this.markSessionConflict(snapshot);
  }

  private markSessionConflict(snapshot: SessionSnapshot): void {
    this.sessionConflict = true;
    this.pendingSessionSnapshot = snapshot;
    new Notice("This card also changed in another view. Saving is paused to protect both versions.");
  }

  private applyDocumentText(text: string): void {
    let source = text;
    let parsed = parseCardDocument(source);
    if (this.file && needsRootHeading(parsed)) {
      source = withSyntheticRootHeading(source, this.file.basename);
      parsed = parseCardDocument(source);
    }
    this.data = source;
    this.parsed = parsed;
    if (source !== text) {
      this.session?.commit(source, this, "local");
      new Notice(`Added a "${this.file!.basename}" heading because the note had no top-level heading.`);
      void this.save();
    }
    let initializingCollapseState = false;
    if (!this.collapseStateInitialized && !hasBlockingIssues(this.parsed) && this.parsed.cards.length > 0) {
      this.collapsedCardIds = new Set(getBranchCardIds(this.parsed.cards));
      this.collapseStateInitialized = true;
      initializingCollapseState = true;
    }
    const cardIds = new Set(this.parsed.cards.map((card) => card.id));
    for (const cardId of this.cardHeights.keys()) {
      if (!cardIds.has(cardId)) {
        this.cardHeights.delete(cardId);
      }
    }
    const depths = new Set(this.parsed.cards.map((card) => card.depth));
    for (const depth of this.columnWidths.keys()) {
      if (!depths.has(depth)) {
        this.columnWidths.delete(depth);
      }
    }
    for (const cardId of this.collapsedCardIds) {
      if (!cardIds.has(cardId)) {
        this.collapsedCardIds.delete(cardId);
      }
    }
    if (!this.selectedCardId || !this.cardById(this.selectedCardId)) {
      this.selectedCardId = this.parsed.roots[0] ?? null;
    }
    if (initializingCollapseState) {
      this.expandCard(this.selectedCardId);
    }
    void this.renderView();
  }

  private async toggleCardCollapsed(cardId: string): Promise<void> {
    const card = this.cardById(cardId);
    if (!card || card.children.length === 0) {
      return;
    }
    const transition = this.captureCardTransition(cardId);
    try {
      if (this.collapsedCardIds.has(cardId)) {
        this.collapsedCardIds.delete(cardId);
      } else {
        for (const descendantId of getOpenBranchDescendants(this.parsed.cards, cardId, this.collapsedCardIds)) {
          this.collapsedCardIds.add(descendantId);
        }
        this.collapsedCardIds.add(cardId);
        if (this.selectedCardId && this.selectedCardId !== cardId && this.isDescendantOf(this.selectedCardId, cardId)) {
          this.selectedCardId = cardId;
        }
      }
      await this.renderView();
      this.animateCardTransition(transition);
      const element = this.cardElement(this.selectedCardId ?? cardId);
      element?.focus({ preventScroll: true });
    } catch (error) {
      this.cancelCardTransition();
      throw error;
    }
  }

  private isDescendantOf(cardId: string, ancestorId: string): boolean {
    let current = this.cardById(cardId);
    while (current?.parentId) {
      if (current.parentId === ancestorId) {
        return true;
      }
      current = this.cardById(current.parentId);
    }
    return false;
  }

  private cardById(id: string): CardNode | null {
    return this.parsed.cards.find((card) => card.id === id) ?? null;
  }

  private headingJumpForCard(card: CardNode): LevelJumpIssue | null {
    return this.parsed.issues.find(
      (issue): issue is LevelJumpIssue => issue.kind === "level-jump" && issue.line === card.range.line
    ) ?? null;
  }

  private cardElement(id: string): HTMLElement | null {
    return this.contentEl.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
  }

  private cardBodyElement(id: string): HTMLElement | null {
    return this.contentEl.querySelector<HTMLElement>(`[data-card-id="${id}"] .visual-card-writer-card-body`);
  }
}
