import { PluginSettingTab, Setting } from "obsidian";
import type VisualCardWriterPlugin from "./plugin";

export type CardDoubleClickAction = "embedded" | "obsidian";
export type MarkdownOpenLocation = "tab" | "right";

export class VisualCardWriterSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: VisualCardWriterPlugin) {
    super(plugin.app, plugin);
  }

  // Fallback for Obsidian 1.12; newer versions use the searchable definitions.
  display(): void {
    this.containerEl.empty();
    for (const definition of this.getSettingDefinitions()) {
      definition.render(new Setting(this.containerEl).setName(definition.name).setDesc(definition.desc));
    }
  }

  getSettingDefinitions(): { name: string; desc: string; render: (setting: Setting) => void }[] {
    return [{
      name: "Card double-click action",
      desc: "Choose which editor opens when you double-click a card.",
      render: (setting) => { setting.addDropdown((dropdown) => dropdown
        .addOption("embedded", "Edit inside the card")
        .addOption("obsidian", "Open in Obsidian editor")
        .setValue(this.plugin.cardDoubleClickAction)
        .onChange(async (value) => {
          await this.plugin.setCardDoubleClickAction(value === "obsidian" ? "obsidian" : "embedded");
        })); }
    }, {
      name: "Obsidian editor location",
      desc: "When using the Obsidian editor, keep Visual Card Writer open and jump to the card's heading. Further double-clicks reuse this editor.",
      render: (setting) => { setting.addDropdown((dropdown) => dropdown
        .addOption("tab", "New tab")
        .addOption("right", "Open to the right")
        .setValue(this.plugin.markdownOpenLocation)
        .onChange(async (value) => {
          await this.plugin.setMarkdownOpenLocation(value === "right" ? "right" : "tab");
        })); }
    }];
  }
}
