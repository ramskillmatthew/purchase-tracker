import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const path = "C:/Users/arams/Downloads/matthew reselling spreadsheet 2025 onwards (1).xlsx";
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(path));

const sheetInfo = await workbook.inspect({
  kind: "sheet",
  include: "id,name",
  maxChars: 10000,
});
console.log("SHEETS");
console.log(sheetInfo.ndjson);

for (const sheet of workbook.worksheets.items) {
  const used = sheet.getUsedRange(true);
  if (!used) continue;
  const values = used.values;
  const formulas = used.formulas;
  const rows = values.length;
  const cols = rows ? Math.max(...values.map(r => r.length)) : 0;
  const matches = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < (values[r]?.length ?? 0); c++) {
      const v = values[r][c];
      if (typeof v === "string" && v.trim().toLowerCase().includes("stock value")) {
        matches.push({ rowOffset: r, colOffset: c, value: v });
      }
    }
  }
  console.log("SHEET_SUMMARY", JSON.stringify({name: sheet.name, rows, cols, matches}));
  if (matches.length) {
    console.log("VALUES", JSON.stringify(values));
    console.log("FORMULAS", JSON.stringify(formulas));
  }
}

const inv = workbook.worksheets.getItem("Inventory");
console.log("INVENTORY_TOP", JSON.stringify(inv.getRange("A1:AD20").values));
console.log("INVENTORY_BOTTOM", JSON.stringify(inv.getRange("A3045:AD3062").values));
for (let c = 0; c < 30; c++) {
  const col = inv.getRangeByIndexes(0, c, 3062, 1).values;
  const textHits = [];
  for (let r = 0; r < col.length; r++) {
    const v = col[r]?.[0];
    if (typeof v === "string" && /stock|value/i.test(v)) textHits.push({row:r+1,value:v});
  }
  if (textHits.length) console.log("TEXT_HITS", JSON.stringify({col:c+1,textHits}));
}

const stockVals = inv.getRange("K1:K3062").values.map(r => r?.[0]);
const positiveRows = [];
for (let row = 3; row <= 3061; row++) {
  const value = stockVals[row - 1];
  if (typeof value === "number" && value > 0) positiveRows.push(row);
}
const ranges = [];
for (const row of positiveRows) {
  const last = ranges[ranges.length - 1];
  if (last && row === last[1] + 1) last[1] = row;
  else ranges.push([row, row]);
}
console.log("POSITIVE_COUNT", positiveRows.length);
console.log("POSITIVE_ROWS", positiveRows.join(", "));
console.log("POSITIVE_RANGES", ranges.map(([a,b]) => a === b ? `${a}` : `${a}-${b}`).join(", "));
console.log("POSITIVE_MIN_MAX_SUM", JSON.stringify({first:positiveRows[0],last:positiveRows.at(-1),sum:positiveRows.reduce((s,r)=>s+stockVals[r-1],0),totalCell:stockVals[3061]}));
