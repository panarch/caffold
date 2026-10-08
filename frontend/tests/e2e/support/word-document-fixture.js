import JSZip from "jszip";

const WORDPROCESSING_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// Packages a Word document body, written by the spec, into .docx bytes. Each
// relationship is `{ id, type, target, external }`, where `type` is the last
// segment of its Office relationship type; `parts` adds files beside
// `word/document.xml`, keyed by their path in the package.
export async function wordDocument({ body, relationships = [], parts = {} }) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="html" ContentType="text/html"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    "</Types>",
  ].join(""));
  zip.file("_rels/.rels", relationshipsXml([
    { id: "rIdDocument", type: "officeDocument", target: "word/document.xml" },
  ]));
  zip.file("word/_rels/document.xml.rels", relationshipsXml(relationships));
  zip.file("word/document.xml", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<w:document xmlns:w="${WORDPROCESSING_NAMESPACE}" xmlns:r="${RELATIONSHIPS_NAMESPACE}">`,
    `<w:body>${body}</w:body>`,
    "</w:document>",
  ].join(""));
  for (const [path, content] of Object.entries(parts)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

function relationshipsXml(relationships) {
  const entries = relationships.map(({ id, type, target, external = false }) =>
    `<Relationship Id="${id}" Type="${RELATIONSHIPS_NAMESPACE}/${type}" ` +
      `Target="${target}"${external ? ' TargetMode="External"' : ""}/>`);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...entries,
    "</Relationships>",
  ].join("");
}
