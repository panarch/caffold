import JSZip from "jszip";

const SPREADSHEET_NAMESPACE =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main";
const THEME_COLOR_NAMES = [
  "dk1", "lt1", "dk2", "lt2",
  "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
  "hlink", "folHlink",
];

// Packages worksheets written by a test into .xlsx bytes. Each sheet is
// `{ name, body, hidden, file, links }`: `body` is the worksheet XML inside
// `<worksheet>`, `file` names its part under `xl/worksheets/`, and `links`
// maps a cell address to an external target or, starting with "#", to a
// location in the workbook. `styles` is the stylesheet XML inside
// `<styleSheet>`, and `themeColors` lists the twelve theme colors as hex in
// the order the theme declares them.
export async function spreadsheetWorkbook({
  sheets,
  styles = "",
  themeColors = null,
}) {
  const zip = new JSZip();
  const files = sheets.map((sheet, index) => sheet.file ?? `sheet${index + 1}.xml`);
  zip.file("[Content_Types].xml", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ...(themeColors
      ? ['<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>']
      : []),
    ...files.map((file) =>
      `<Override PartName="/xl/worksheets/${file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    "</Types>",
  ].join(""));
  zip.file("_rels/.rels", relationshipsXml([
    { id: "rIdWorkbook", type: "officeDocument", target: "xl/workbook.xml" },
  ]));
  zip.file("xl/_rels/workbook.xml.rels", relationshipsXml([
    ...files.map((file, index) => ({
      id: `rIdSheet${index + 1}`,
      type: "worksheet",
      target: `worksheets/${file}`,
    })),
    { id: "rIdStyles", type: "styles", target: "styles.xml" },
    ...(themeColors ? [{ id: "rIdTheme", type: "theme", target: "theme/theme1.xml" }] : []),
  ]));
  zip.file("xl/workbook.xml", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<workbook xmlns="${SPREADSHEET_NAMESPACE}" xmlns:r="${RELATIONSHIPS_NAMESPACE}"><sheets>`,
    ...sheets.map(({ name, hidden = false }, index) =>
      `<sheet name="${name}" sheetId="${index + 1}"${hidden ? ' state="hidden"' : ""} ` +
        `r:id="rIdSheet${index + 1}"/>`),
    "</sheets></workbook>",
  ].join(""));
  zip.file("xl/styles.xml", [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<styleSheet xmlns="${SPREADSHEET_NAMESPACE}">${styles}</styleSheet>`,
  ].join(""));
  if (themeColors) {
    zip.file("xl/theme/theme1.xml", themeXml(themeColors));
  }
  for (const [index, { body, links = {} }] of sheets.entries()) {
    const external = Object.entries(links).filter(([, target]) => !target.startsWith("#"));
    const hyperlinks = Object.entries(links).map(([cell, target]) =>
      target.startsWith("#")
        ? `<hyperlink ref="${cell}" location="${target.slice(1)}"/>`
        : `<hyperlink ref="${cell}" r:id="rIdLink${external.findIndex(([name]) => name === cell) + 1}"/>`);
    zip.file(`xl/worksheets/${files[index]}`, [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      `<worksheet xmlns="${SPREADSHEET_NAMESPACE}" xmlns:r="${RELATIONSHIPS_NAMESPACE}">`,
      body,
      hyperlinks.length ? `<hyperlinks>${hyperlinks.join("")}</hyperlinks>` : "",
      "</worksheet>",
    ].join(""));
    if (external.length) {
      zip.file(`xl/worksheets/_rels/${files[index]}.rels`, relationshipsXml(
        external.map(([, target], position) => ({
          id: `rIdLink${position + 1}`,
          type: "hyperlink",
          target,
          external: true,
        })),
      ));
    }
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

// A row of inline-string and number cells, for sheets whose cells need no
// more than a value: a string becomes text, a number stays a number.
export function cellRow(row, values) {
  const cells = values.map((value, index) => {
    const reference = `${columnName(index)}${row}`;
    return typeof value === "number"
      ? `<c r="${reference}"><v>${value}</v></c>`
      : `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`;
  });
  return `<row r="${row}">${cells.join("")}</row>`;
}

export function columnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  }
  return name;
}

function themeXml(colors) {
  const scheme = THEME_COLOR_NAMES.map((name, index) =>
    `<a:${name}><a:srgbClr val="${colors[index]}"/></a:${name}>`);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<a:theme xmlns:a="${DRAWING_NAMESPACE}" name="Fixture"><a:themeElements>`,
    `<a:clrScheme name="Fixture">${scheme.join("")}</a:clrScheme>`,
    '<a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont>',
    '<a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme>',
    '<a:fmtScheme name="Fixture"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme>',
    "</a:themeElements></a:theme>",
  ].join("");
}

function relationshipsXml(relationships) {
  const entries = relationships.map(({ id, type, target, external = false }) =>
    `<Relationship Id="${id}" Type="${RELATIONSHIPS_NAMESPACE}/${type}" ` +
      `Target="${target}"${external ? ' TargetMode="External"' : ""}/>`);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NAMESPACE}">`,
    ...entries,
    "</Relationships>",
  ].join("");
}
