# Visual Card Writer

Visual Card Writer is a desktop plugin for [Obsidian](https://obsidian.md) that turns an ordinary Markdown note into a spatial, card-based writing interface.

The document remains standard Markdown. ATX headings define the hierarchy, and every card edits the corresponding section of the same source file.

> Visual Card Writer is currently an early beta. Back up important notes and test the workflow before adopting it for critical writing.

<img src="./Obsidian-visual-card-writer.gif" width="460" alt="Obsidian Visual Writer">

_GIF showing the UI in action_


## Features

- Navigate a Markdown outline as aligned cards in a horizontal or vertical tree.
- Switch between **Horizontal** and **Vertical** from the editor toolbar; the preference persists across plugin reloads.
- Follow subtle directional arrows from each card to its first visible child without adding extra space between cards.
- Keep every branch visible with contextual dimming, or collapse complete subtrees.
- Create child and sibling cards without leaving the visual editor.
- Edit cards with an embedded CodeMirror 6 editor and essential Live Preview.
- Resize complete columns horizontally and individual cards vertically.
- Pan with the middle mouse button and zoom with `Ctrl`/`Cmd` + mouse wheel.
- Animate selection, expansion, collapse, and layout changes to preserve visual context.
- Preserve standard Markdown without proprietary comments or metadata.

## Document format

The hierarchy comes exclusively from ATX headings:

```markdown
# Chapter

Introductory text.

## Scene

Scene content.

### Detail

Supporting detail.
```

Changing a heading level changes that card's position in the hierarchy. Content before the first heading remains outside the card tree.

The hierarchy must start at an H1. If a note has no headings at all, or its topmost headings start below H1 (for example several H2s with no H1 above them), Visual Card Writer automatically inserts a `# <file name>` heading at the top of the note so it has a valid root card, then saves the note with that heading in place.

### Repair skipped heading levels

Skipped heading levels do not block the card editor. If an H3 follows an H1, for example, Visual Card Writer shows the H3 as a direct logical child and marks that card with an amber heading hint. The hint can move only that branch up to the expected level, insert the missing parent card, or leave the Markdown unchanged.

<img src="./skipped-heading-repair.png" width="900" alt="Visual Card Writer showing an H1-to-H3 heading jump and the local repair menu">

### Horizontal and vertical layouts

Horizontal layout remains the default and grows the hierarchy from left to right. Vertical layout transposes the same tree so hierarchy levels grow downward and sibling branches spread from left to right, which works better in portrait windows. Subtle arrows connect each card to its first visible child and rotate with the layout, making the reading direction explicit without increasing the gaps. Both orientations use the same Markdown, cards, folding state, zoom, editing, and resize controls.

<img src="./vertical-card-layout.png" width="900" alt="Visual Card Writer showing a Markdown hierarchy growing downward in vertical layout">

## Installation

### Community plugins

Visual Card Writer is listed in Obsidian's Community plugins directory. Open **Settings → Community plugins → Browse**, search for **Visual Card Writer**, and install it from there.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the matching GitHub release.
2. Create `<vault>/.obsidian/plugins/visual-card-writer/`.
3. Copy the three files into that directory.
4. Reload Obsidian and enable **Visual Card Writer** under **Settings → Community plugins**.

## Usage

Open a Markdown note and run **Visual Card Writer: Open current note in card editor** from the command palette.

- Select a card to navigate its branch.
- Click the pencil or double-click a card to edit it.
- Click outside the card to save and leave editing.
- Use the `+` button to create a child card.
- Use a card's chevron to expand or collapse its children.
- Choose **Horizontal** or **Vertical** in the toolbar to change the direction of the tree.
- Drag the right edge to resize every card at that hierarchy level.
- Drag the bottom edge to resize one card vertically.
- Middle-drag the background to pan.
- Hold `Ctrl`/`Cmd` and use the mouse wheel to zoom.

### Commands

- **Visual Card Writer: Open current note in card editor**
- **Visual Card Writer: Switch back to Markdown editor**
- **Visual Card Writer: Add child card**
- **Visual Card Writer: Add sibling card below**
- **Visual Card Writer: Toggle horizontal or vertical card layout**

## Current limitations

- Desktop only.
- Live Preview covers the essential inline Markdown constructs; images, embeds, callouts, and complex block widgets remain source Markdown while editing.
- Skipped heading levels are inferred from the nearest preceding shallower heading and remain visible as local, repairable hints.
- The plugin is under active development and its interaction details may still change.

## Development

Requirements: Node.js 22.13 or later and pnpm 11.

```bash
pnpm install
pnpm run dev
```

Run the complete verification suite with:

```bash
pnpm run check
```

The production build writes an ignored `main.js` at the repository root. Automated releases attach `main.js`, `manifest.json`, and `styles.css` to a tag whose name exactly matches the manifest version, without a `v` prefix. Compiled plugin files belong in GitHub releases, not in the repository history.

## Privacy

Visual Card Writer processes notes locally inside Obsidian. It does not include analytics, advertising, accounts, or network services.

## Contributing

Bug reports and focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development note

> Visual Card Writer was unapologetically vibe-coded: built iteratively with AI assistance, then tested and refined inside a real Obsidian vault.

## License

[MIT](LICENSE) © David Hurtado
