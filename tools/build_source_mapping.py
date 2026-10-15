"""Write docs/SOURCE_MAPPING.md: every template item with its file / worksheet / cell."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORDER = ["GA", "GA_Inspection", "BS", "PS", "LOG", "PT_Sub_Line_Engine", "PT_Battery"]


def cell(s):
    return f"`{s['sheet']}!{s['cell']}`"


def one(t):
    return " ".join(t.split())


out = ["# Source Mapping · CPS PJO Audit", "",
       "ทุกข้อในแม่แบบดึงจากไฟล์ต้นฉบับโดย `tools/extract_templates.py` (ไม่มีการพิมพ์ใหม่) ตารางนี้สร้างอัตโนมัติด้วย `python tools/build_source_mapping.py`", "",
       "| Workshop | ตาราง 1 | ตาราง 2 | ตาราง 3 (รวมข้อเสนอแนะ) | ตาราง 4 (กรณี) | ไฟล์ต้นฉบับ |", "|---|---|---|---|---|---|"]
data = {c: json.loads((ROOT / "pjo/seed/templates" / f"{c}.json").read_text(encoding="utf8")) for c in ORDER}
for c, t in data.items():
    out.append(f"| {t['name']} | {len(t['s1']['items'])} | {sum(len(s['items']) for s in t['s2']['sections'])} | {len(t['s3']['questions'])} | {len(t['s4']['cases'])} | `{t['source_file']}` |")
for c, t in data.items():
    out += ["", f"## {t['name']}", "", f"ไฟล์: `{t['source_file']}`", "", "### ตาราง 1 · ระยะที่ 1 ส่วนที่ 1", "",
            "| Key | ข้อ | ประเภท | ข้อความ | Cell |", "|---|---|---|---|---|"]
    for i in t["s1"]["items"]:
        out.append(f"| {i['key']} | {i['no']} | {'หลัก' if i['severity']=='major' else 'รอง'}{' · วัดเวลา' if i['kind']=='timing' else ''} | {one(i['text'])} | {cell(i['source'])} |")
    out += ["", "### ตาราง 2 · ระยะที่ 1 ส่วนที่ 2", "", "| Key | รหัส | ข้อความ | Cell |", "|---|---|---|---|"]
    for s in t["s2"]["sections"]:
        for i in s["items"]:
            out.append(f"| {i['key']} | {i['code']} | {one(i['text'])} | {cell(i['source'])} |")
    out += ["", "### ตาราง 3 · ระยะที่ 2", "", "| Key | ข้อ | คำถาม | คำตอบที่คาดหวัง | Cell |", "|---|---|---|---|---|"]
    for q in t["s3"]["questions"]:
        out.append(f"| {q['key']} | {q['no']} | {one(q['text'])} | {one(q['expected'])} | {cell(q['source'])} / {q['expected_source']['cell']} |")
    out += ["", "### ตาราง 4 · ระยะที่ 3", "", "| Key | แนวทาง | กรณี | คำตอบที่พึงประสงค์ | Cell |", "|---|---|---|---|---|"]
    for k in t["s4"]["cases"]:
        out.append(f"| {k['key']} | {one(k['category'])} | {one(k['case'])} | {one(k['answer'])} | {cell(k['source'])} |")
    if t["ignored_sample_values"]:
        out += ["", "**ค่าที่กรอกค้างในไฟล์และไม่ได้นำเข้า:** " + ", ".join(f"{x['source']['sheet']}!{x['source']['cell']}=“{x['value']}”" for x in t["ignored_sample_values"])]
(ROOT / "docs/SOURCE_MAPPING.md").write_text("\n".join(out) + "\n", encoding="utf8")
print("written", len(out), "lines")
