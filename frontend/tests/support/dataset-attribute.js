// A fake element's `getAttribute` for its data attributes, read from its
// `dataset` the way a browser maps one onto the other.
export function datasetAttribute(name) {
  const key = name
    .replace(/^data-/, "")
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return this.dataset[key] ?? null;
}
