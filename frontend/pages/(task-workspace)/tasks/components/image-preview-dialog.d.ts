// What TypeScript modules use from image-preview-dialog.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

export function requestTaskImagePreview(
  target: Element,
  image: { src: string; name: string },
): boolean;
