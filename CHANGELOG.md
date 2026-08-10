# Changelog

All notable changes to Visual Card Writer will be documented here.

## 0.1.5

- Reveal a card's children as soon as it is selected, at every heading level, without moving the selection to them. Opening a note now shows the first H1 selected with its children already visible, instead of a single collapsed card.

## 0.1.4

- Make the text selection visible again while editing a card. The active-line highlight used an opaque background, which covered CodeMirror's selection layer, so double-clicking a word left it looking unselected while every other occurrence of that word lit up as a match.
- Stop clicks inside an open card editor from being treated as card clicks. They moved keyboard focus from the editor to the card and replayed the viewport animation on every click.

## 0.1.3

- When a note has no H1 (no headings at all, or the topmost headings start below H1), automatically insert an `# <file name>` heading so the note has a valid card root instead of blocking the card editor.

## 0.1.2

- Preserve the user's card-view leaf placement when the plugin unloads or reloads.
- Remove a partially supported CSS decoration property flagged by the Obsidian review.

## 0.1.1

- Prepared the plugin for Obsidian Community directory review.
- Removed compiled output from repository tracking and minified production builds.
- Replaced hardcoded dynamic layout styles with scoped CSS custom properties.
- Removed remaining prototype terminology and strengthened release validation.

## 0.1.0

- Initial public beta.
- Card hierarchy derived from standard ATX Markdown headings.
- Collapsible branches with animated layout transitions.
- Embedded CodeMirror 6 editing with essential Live Preview.
- Child and sibling card creation.
- Column and card resizing, panning, and zooming.
