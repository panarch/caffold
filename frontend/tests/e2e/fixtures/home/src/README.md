# Markdown file preview

Caffold renders **textual Markdown** and `inline code` from the selected file.

- Headings, lists, and prose stay readable.
- Embedded resources stay out of this preview.

| Surface | Behavior |
| --- | --- |
| Source | Shows the file text |
| Preview | Renders safe text content |

```rust
fn review() {
    println!("preview");
}
```

[External documentation](https://example.com/docs)

[Sibling source](./alpha.rs)

<img src="https://example.com/preview.png" alt="Architecture diagram">

<script>window.__caffoldMarkdownPreviewScriptRan = true;</script>

## Long review notes

1. Keep the selected path stable.
2. Keep the representation stable.
3. Preserve local scroll during background refresh.
4. Keep wide tables inside the component scroller.
5. Keep code blocks readable without widening the page.
6. Keep embedded resources out of the text-only preview.
7. Keep local links non-interactive until navigation is supported.
8. Keep external links explicit and safe.
9. Keep parser failures readable as plain text.
10. Keep desktop, foldable, and phone layouts inspectable.
