"""Dump the brand/model workbook to data/raw/xlsx_models.json (run once)."""
import sys, io, json, os
import openpyxl

src = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\stark\Downloads\All_Brands_Models.xlsx"
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "raw", "xlsx_models.json")
os.makedirs(os.path.dirname(out), exist_ok=True)

wb = openpyxl.load_workbook(src, read_only=True, data_only=True)
rows = []
for ws in wb.worksheets:
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r or not r[3]:
            continue
        rows.append({"brand": ws.title, "serial": r[0], "gsm": r[1], "img": r[2],
                     "name": str(r[3]).strip(),
                     "release": str(r[4]) if r[4] is not None else "",
                     "size": r[5], "h": r[6], "w": r[7], "scr": r[8], "ratio": r[9], "mah": r[10]})
json.dump(rows, io.open(out, "w", encoding="utf8"), ensure_ascii=False)
print("wrote", len(rows), "models ->", out)
