// Moves a Section or a row to its place in the list. Where the browser has
// `moveBefore()` the item stays connected, so a gesture in progress, focus,
// and animations carry on.
export function moveListItemBefore(
  parent: Element,
  item: Element,
  before: Element | null,
) {
  const movable = parent as Element & {
    moveBefore?: (node: Node, child: Node | null) => void;
  };
  if (movable.moveBefore && parent.isConnected && item.isConnected) {
    movable.moveBefore(item, before);
  } else {
    parent.insertBefore(item, before);
  }
}
