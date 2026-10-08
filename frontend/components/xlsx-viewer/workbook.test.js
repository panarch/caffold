import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import { spreadsheetWorkbook } from "../../tests/support/spreadsheet-fixture.js";
import { colorValue, readWorkbook } from "./workbook.js";

// Office's default theme, in the order a theme declares its colors: dark 1,
// light 1, dark 2, light 2, six accents, and the two link colors.
const THEME_COLORS = [
  "000000", "FFFFFF", "44546A", "E7E6E6",
  "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47",
  "0563C1", "954F72",
];

// Style 1 sets every font, fill, border, and alignment property the viewer
// draws; styles 2 to 4 only format numbers. Its font color is theme index 3,
// which Excel counts as dark 2 although the theme declares light 2 there.
const STYLES = `
  <numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><i/><u/><strike/><sz val="14"/><color theme="3"/><name val="Arial"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor theme="4" tint="0.4"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFFF0000"/></left><right/><top/><bottom style="double"><color indexed="64"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="top" wrapText="1"/>
    </xf>
    <xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>`;

const SUMMARY = {
  name: "Summary",
  body: `
    <sheetViews><sheetView workbookViewId="0">
      <pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/>
    </sheetView></sheetViews>
    <sheetFormatPr defaultRowHeight="20"/>
    <cols>
      <col min="2" max="2" width="20" customWidth="1"/>
      <col min="3" max="3" width="9" hidden="1"/>
      <col min="4" max="4" width="9" style="2"/>
    </cols>
    <sheetData>
      <row r="1">
        <c r="A1" t="inlineStr"><is><t>Web</t></is></c>
        <c r="B1" s="1" t="inlineStr"><is><t>Styled</t></is></c>
        <c r="C1" s="2"><v>0.25</v></c>
        <c r="D1" s="3"><v>45293</v></c>
        <c r="E1" t="b"><v>1</v></c>
        <c r="F1" t="e"><v>#DIV/0!</v></c>
        <c r="G1" s="4"><v>3</v></c>
      </row>
      <row r="2" ht="30" customHeight="1" s="1" customFormat="1">
        <c r="A2" t="inlineStr"><is><t>Mail</t></is></c>
      </row>
      <row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Script</t></is></c></row>
      <row r="4"><c r="A4" t="inlineStr"><is><t>Jump</t></is></c><c r="F4"><v>1</v></c></row>
    </sheetData>
    <mergeCells count="1"><mergeCell ref="B2:C3"/></mergeCells>`,
  links: {
    A1: "https://example.com/report",
    A2: "mailto:team@example.com",
    A3: "javascript:alert(1)",
    A4: "#Notes!A1",
  },
};

async function summaryWorkbook() {
  return readWorkbook(XLSX, await spreadsheetWorkbook({
    styles: STYLES,
    themeColors: THEME_COLORS,
    sheets: [
      SUMMARY,
      {
        name: "Notes",
        hidden: true,
        body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>',
      },
    ],
  }));
}

test("sizes rows and columns as Excel does and collapses the hidden ones", async () => {
  const sheet = (await summaryWorkbook()).sheet(0);

  assert.equal(sheet.rowCount, 4);
  assert.equal(sheet.columnCount, 7);
  // The sheet's 20pt default row, a 30pt row, and a hidden one.
  assert.deepEqual([...sheet.rowHeights], [80 / 3, 40, 0, 80 / 3]);
  // Excel's 64px default column, widths counted in Calibri 11 digits with
  // their padding, and a hidden column.
  assert.deepEqual([...sheet.columnWidths], [64, 140, 0, 63, 64, 64, 64]);
});

test("reads the frozen panes and merged cells of a sheet", async () => {
  const sheet = (await summaryWorkbook()).sheet(0);

  assert.equal(sheet.frozenRows, 2);
  assert.equal(sheet.frozenColumns, 1);
  assert.deepEqual(sheet.merges, [{ top: 1, left: 1, bottom: 2, right: 2 }]);
  assert.deepEqual(sheet.mergeAt(1, 1), sheet.merges[0]);
  assert.equal(sheet.mergeAt(1, 2), null);
  assert.equal(sheet.isCovered(1, 1), false);
  assert.equal(sheet.isCovered(1, 2), true);
  assert.equal(sheet.isCovered(2, 1), true);
  assert.equal(sheet.isCovered(2, 2), true);
  assert.equal(sheet.isCovered(3, 1), false);
});

test("keeps only the part of a merge inside the cells in use", async () => {
  const sheet = readWorkbook(XLSX, await spreadsheetWorkbook({
    sheets: [{
      name: "Wide merges",
      body: `
        <sheetData>
          <row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>
          <row r="4"><c r="B4"><v>3</v></c></row>
        </sheetData>
        <mergeCells count="3">
          <mergeCell ref="A3:A1048576"/>
          <mergeCell ref="B1:XFD1"/>
          <mergeCell ref="D8:E9"/>
        </mergeCells>`,
    }],
  })).sheet(0);

  assert.equal(sheet.rowCount, 4);
  assert.equal(sheet.columnCount, 2);
  assert.deepEqual(sheet.merges, [
    { top: 2, left: 0, bottom: 3, right: 0 },
    { top: 0, left: 1, bottom: 0, right: 1 },
  ]);
  assert.equal(sheet.isCovered(3, 0), true);
  assert.equal(sheet.isCovered(4, 0), false);
});

test("gives a cell its own style, else its row's, else its column's", async () => {
  const sheet = (await summaryWorkbook()).sheet(0);

  assert.equal(sheet.styleAt(0, 1), 1);
  assert.equal(sheet.styleAt(0, 3), 3);
  // Row 2 is formatted as a whole, which wins over column D's style.
  assert.equal(sheet.styleAt(1, 0), 1);
  assert.equal(sheet.styleAt(1, 3), 1);
  assert.equal(sheet.styleAt(3, 3), 2);
  assert.equal(sheet.styleAt(3, 0), 0);
});

test("draws a cell style's font, fill, borders, and alignment as CSS", async () => {
  const { styles } = await summaryWorkbook();

  assert.deepEqual(styles[0], {
    declarations: [
      ["font-family", '"Calibri", sans-serif'],
      ["font-size", "11pt"],
    ],
    alignsHorizontally: false,
  });
  assert.deepEqual(styles[1], {
    declarations: [
      ["font-family", '"Arial", sans-serif'],
      ["font-size", "14pt"],
      ["font-weight", "700"],
      ["font-style", "italic"],
      ["text-decoration", "underline line-through"],
      ["color", "#44546A"],
      // Accent 1 lightened by 40%, Excel's "Blue, Accent 1, Lighter 40%".
      ["background-color", "#8FAADC"],
      ["border-left", "1px solid #FF0000"],
      ["border-bottom", "3px double #000000"],
      ["justify-content", "center"],
      ["text-align", "center"],
      ["align-items", "start"],
      ["white-space", "pre-wrap"],
    ],
    alignsHorizontally: true,
  });
  assert.equal(styles.length, 5);
});

test("shows each value as Excel displays it, with its type", async () => {
  const sheet = (await summaryWorkbook()).sheet(0);

  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((column) => sheet.cellAt(0, column)),
    [
      { text: "Styled", kind: "s", link: null },
      { text: "25.00%", kind: "n", link: null },
      { text: "1/2/24", kind: "d", link: null },
      { text: "TRUE", kind: "b", link: null },
      { text: "#DIV/0!", kind: "e", link: null },
      { text: "3.0", kind: "n", link: null },
    ],
  );
  assert.equal(sheet.cellAt(2, 2), null);
  assert.equal(sheet.cellAt(10, 0), null);
});

test("links a cell only to a web or mail address", async () => {
  const sheet = (await summaryWorkbook()).sheet(0);

  assert.deepEqual([0, 1, 2, 3].map((row) => sheet.cellAt(row, 0)), [
    { text: "Web", kind: "s", link: "https://example.com/report" },
    { text: "Mail", kind: "s", link: "mailto:team@example.com" },
    { text: "Script", kind: "s", link: null },
    { text: "Jump", kind: "s", link: null },
  ]);
});

test("lists every sheet with its hidden state and reads each one once", async () => {
  const workbook = await summaryWorkbook();

  assert.deepEqual(workbook.sheets, [
    { name: "Summary", hidden: false },
    { name: "Notes", hidden: true },
  ]);
  assert.equal(workbook.sheet(0), workbook.sheet(0));
  assert.equal(workbook.sheet(1).rowCount, 1);
});

test("finds each sheet's XML through the workbook's relationships", async () => {
  // The first sheet is stored in the part a default layout gives the second,
  // so only its relationship says where its frozen pane is.
  const workbook = readWorkbook(XLSX, await spreadsheetWorkbook({
    sheets: [
      {
        name: "Frozen",
        file: "sheet2.xml",
        body: `
          <sheetViews><sheetView workbookViewId="0">
            <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
          </sheetView></sheetViews>
          <sheetData><row r="2"><c r="A2"><v>1</v></c></row></sheetData>`,
      },
      {
        name: "Plain",
        file: "sheet1.xml",
        body: '<sheetData><row r="2"><c r="A2"><v>1</v></c></row></sheetData>',
      },
    ],
  }));

  assert.equal(workbook.sheet(0).frozenRows, 1);
  assert.equal(workbook.sheet(1).frozenRows, 0);
});

test("leaves a workbook without styles or a theme in Excel's defaults", async () => {
  const workbook = readWorkbook(XLSX, await spreadsheetWorkbook({
    sheets: [{
      name: "Bare",
      body: '<sheetData><row r="1"><c r="B1"><v>1</v></c></row></sheetData>',
    }],
  }));
  const sheet = workbook.sheet(0);

  assert.deepEqual([...sheet.rowHeights], [20]);
  assert.deepEqual([...sheet.columnWidths], [64, 64]);
  assert.equal(sheet.frozenRows, 0);
  assert.equal(sheet.frozenColumns, 0);
  assert.equal(sheet.styleAt(0, 1), 0);
  assert.deepEqual(sheet.cellAt(0, 1), { text: "1", kind: "n", link: null });
});

test("darkens a theme color by a negative tint and ignores what is no color", () => {
  const palette = [{ rgb: "FFFFFF" }, { rgb: "000000" }, { rgb: "E7E6E6" }];

  assert.equal(colorValue({ theme: 0, tint: -0.5 }, palette), "#808080");
  assert.equal(colorValue({ rgb: "FF00B050", tint: 0.5 }, palette), "#00B050");
  assert.equal(colorValue({ indexed: 9 }, palette), "#FFFFFF");
  assert.equal(colorValue({ indexed: 22 }, palette), null);
  assert.equal(colorValue({ theme: 7 }, palette), null);
  assert.equal(colorValue({ rgb: "not-a-color" }, palette), null);
  assert.equal(colorValue(undefined, palette), null);
});
