// What TypeScript modules use from component-styles.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

// A shared style a component applies to one of its own elements: `owner` is
// the component's element name and `target` the child path to the element.
export interface SharedStyle {
  register(owner: string, target: string): Promise<void>;
}

export const compactIconButton: SharedStyle;

export const busySpin: SharedStyle;
