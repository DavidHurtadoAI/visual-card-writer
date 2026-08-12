import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { DocumentSessionRegistry } from "./session";
import type { LayoutOrientation } from "./types";
import { CARD_VIEW_TYPE, VisualCardWriterView } from "./view";

interface VisualCardWriterSettings {
  layoutOrientation: LayoutOrientation;
}

const DEFAULT_SETTINGS: VisualCardWriterSettings = {
  layoutOrientation: "horizontal"
};

export default class VisualCardWriterPlugin extends Plugin {
  private readonly sessions = new DocumentSessionRegistry();
  private pluginSettings: VisualCardWriterSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    this.pluginSettings = {
      ...DEFAULT_SETTINGS,
      ...((await this.loadData()) as Partial<VisualCardWriterSettings> | null)
    };
    if (
      this.pluginSettings.layoutOrientation !== "horizontal" &&
      this.pluginSettings.layoutOrientation !== "vertical"
    ) {
      this.pluginSettings.layoutOrientation = DEFAULT_SETTINGS.layoutOrientation;
    }

    this.registerView(
      CARD_VIEW_TYPE,
      (leaf) =>
        new VisualCardWriterView(
          leaf,
          this.sessions,
          this.pluginSettings.layoutOrientation,
          (orientation) => this.saveLayoutOrientation(orientation)
        )
    );

    this.addCommand({
      id: "open-card-editor",
      name: "Open current note in card editor",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const available = file instanceof TFile && file.extension.toLowerCase() === "md";
        if (available && !checking && file) {
          void this.openFileInCardView(file);
        }
        return available;
      }
    });

    this.addCommand({
      id: "switch-to-markdown-editor",
      name: "Switch back to Markdown editor",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(VisualCardWriterView);
        if (view && !checking) {
          void view.switchToMarkdown();
        }
        return view != null;
      }
    });

    this.addCommand({
      id: "add-child-card",
      name: "Add child card",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(VisualCardWriterView);
        const available = view?.canCreateChildCard() ?? false;
        if (available && !checking && view) {
          void view.createChildCard();
        }
        return available;
      }
    });

    this.addCommand({
      id: "add-sibling-card-below",
      name: "Add sibling card below",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(VisualCardWriterView);
        const available = view?.canCreateSiblingCard() ?? false;
        if (available && !checking && view) {
          void view.createSiblingCardBelow();
        }
        return available;
      }
    });

    this.addCommand({
      id: "toggle-layout-orientation",
      name: "Toggle horizontal or vertical card layout",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(VisualCardWriterView);
        if (view && !checking) {
          void view.toggleLayoutOrientation();
        }
        return view != null;
      }
    });

    this.registerCliHandler(
      "visual-card-writer:open",
      "Open a Markdown file in Visual Card Writer",
      { path: { value: "<path>", description: "Vault-relative Markdown path", required: true } },
      async (params) => {
        const path = normalizePath(params.path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
          throw new Error(`Markdown file not found: ${path}`);
        }
        const view = await this.openFileInCardView(file);
        return JSON.stringify(view.getDiagnostics());
      }
    );

    this.registerCliHandler(
      "visual-card-writer:status",
      "Return diagnostics for the active Visual Card Writer view",
      null,
      () => JSON.stringify(this.requireActiveView().getDiagnostics())
    );

    this.registerCliHandler(
      "visual-card-writer:status-all",
      "Return diagnostics for every open Visual Card Writer view",
      null,
      () =>
        JSON.stringify(
          this.app.workspace
            .getLeavesOfType(CARD_VIEW_TYPE)
            .map((leaf) => (leaf.view instanceof VisualCardWriterView ? leaf.view.getDiagnostics() : null))
            .filter((diagnostics) => diagnostics != null)
        )
    );

    this.registerCliHandler(
      "visual-card-writer:sessions",
      "Return shared DocumentSession diagnostics",
      null,
      () => JSON.stringify(this.sessions.diagnostics())
    );

    this.registerCliHandler(
      "visual-card-writer:open-second",
      "Diagnostics: open a second card view for the same Markdown file",
      { path: { value: "<path>", description: "Vault-relative Markdown path", required: true } },
      async (params) => {
        const file = this.requireMarkdownFile(params.path);
        const view = await this.openFileInCardView(file, true);
        return JSON.stringify(view.getDiagnostics());
      }
    );

    this.registerCliHandler(
      "visual-card-writer:start-editing",
      "Diagnostics: mount CodeMirror in the active card",
      null,
      async () => {
        const view = this.requireActiveView();
        await view.startEditing();
        return JSON.stringify(view.getDiagnostics());
      }
    );

    this.registerCliHandler(
      "visual-card-writer:replace-active-card",
      "Diagnostics: replace the active card Markdown and save it",
      { content: { value: "<markdown>", description: "Complete card Markdown", required: true } },
      async (params) => JSON.stringify(await this.requireActiveView().replaceActiveCardForDiagnostics(params.content))
    );

    this.registerCliHandler(
      "visual-card-writer:cycle-editor",
      "Diagnostics: mount and destroy the active CodeMirror editor repeatedly",
      { count: { value: "<number>", description: "Cycles, from 1 to 200", required: true } },
      async (params) =>
        JSON.stringify(await this.requireActiveView().cycleEditorForDiagnostics(Number.parseInt(params.count, 10)))
    );

    this.registerCliHandler(
      "visual-card-writer:set-layout",
      "Diagnostics: set the active card view layout orientation",
      { orientation: { value: "<horizontal|vertical>", description: "Card layout orientation", required: true } },
      async (params) => {
        const orientation = params.orientation;
        if (orientation !== "horizontal" && orientation !== "vertical") {
          throw new Error(`Unsupported card layout orientation: ${orientation}`);
        }
        const view = this.requireActiveView();
        await view.setLayoutOrientation(orientation);
        return JSON.stringify(view.getDiagnostics());
      }
    );
  }

  onunload(): void {
    this.sessions.clear();
  }

  async openFileInCardView(file: TFile, split = false): Promise<VisualCardWriterView> {
    const leaf = this.app.workspace.getLeaf(split ? "split" : false);
    await leaf.setViewState({ type: CARD_VIEW_TYPE, state: { file: file.path }, active: true });
    const view = leaf.view;
    if (!(view instanceof VisualCardWriterView)) {
      throw new Error("Obsidian did not create the Visual Card Writer view.");
    }
    return view;
  }

  private requireActiveView(): VisualCardWriterView {
    const view = this.app.workspace.getActiveViewOfType(VisualCardWriterView);
    if (!view) {
      new Notice("Open a note in Visual Card Writer first.");
      throw new Error("No active Visual Card Writer view.");
    }
    return view;
  }

  private requireMarkdownFile(rawPath: string): TFile {
    const path = normalizePath(rawPath);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
      throw new Error(`Markdown file not found: ${path}`);
    }
    return file;
  }

  private async saveLayoutOrientation(layoutOrientation: LayoutOrientation): Promise<void> {
    this.pluginSettings = { ...this.pluginSettings, layoutOrientation };
    await this.saveData(this.pluginSettings);
  }
}
