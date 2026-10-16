# การเชื่อมต่อ PJO Audit → ระบบ CPS (สำหรับผู้ดูแลระบบ CPS)

แอป PJO Audit (Google Apps Script) ให้ระบบ CPS **ดึงข้อมูลแบบอ่านอย่างเดียว** ผ่าน Web app URL เดิม (ลงท้าย `/exec`)

## ตั้งค่า

1. เปิดโปรเจกต์ Apps Script **CPS PJO Audit** แล้วรันฟังก์ชัน `cpsExportSetup`
2. ดู **Export key** ใน Execution log
3. ในระบบ CPS ไปที่ PJO › ตั้งค่าการเชื่อมต่อ แล้วใส่ Web app URL กับ Export key
4. ตั้งให้ Sync ทุก 720 นาที

ถ้าต้องการเปลี่ยน key ให้รัน `cpsExportResetKey`

## วิธีเรียก

```
GET <Web app URL>?cps=export&key=<Export key>&since=<ISO เวลา>&ack=<ISO เวลา>&images=1
```

| พารามิเตอร์ | ความหมาย |
|---|---|
| `key` (หรือ `export_key`) | จำเป็น |
| `since` | ส่ง `generated_at` ของครั้งก่อน เพื่อรับเฉพาะ Audit และปัญหาที่เปลี่ยนหลังจากนั้น (แผนตรวจส่งมาทุกครั้ง) |
| `ack` | ส่ง `generated_at` ของครั้งที่ CPS **บันทึกสำเร็จแล้ว** ช่วยให้แอปล้างข้อมูลของตัวเองได้ |
| `images=0` | ไม่ส่งรูปลายเซ็นและรูปถ่าย (ค่าเริ่มต้นคือส่ง) |

> Google จะ redirect `/exec` ไปที่ `script.googleusercontent.com` ตัวเรียกต้องตาม redirect ด้วย เช่น `requests.get(..., allow_redirects=True)`

## ข้อมูลที่ได้ (JSON, `schema: "cps-pjo-export/1"`)

- `generated_at`
- `window`: ช่วงเวลาตรวจมาตรฐาน
- `holidays`: วันหยุดโรงงาน
- `workshops`, `teams`
- `plans[]`: แผนตรวจทุกแผน
  - `state.code` เป็นหนึ่งใน `ok`, `short`, `late`, `missed`, `overdue`, `in_progress`, `today`, `planned`
  - `state.color`, `state.timing` (เริ่ม/ส่ง/นาที) และ `history` (ประวัติการเปลี่ยนแผน)
- `audits[]`
  - `index`: แถวสรุปสำหรับตาราง PJO Record ได้แก่ เลข Audit, วันที่, กะ, Workshop, Team, Station, Model, พนักงาน, ผู้ตรวจ, Rev, Issue เปิด, สถานะ
  - `audit`: ผลการตรวจทั้งหมด ได้แก่ header, marks `{"S1-1|1": {v: "pass|fail|na"}}`, suggestions (ตาราง 2), s3, s4, timings, followups, revisions
  - `snapshot`: แบบฟอร์มมาตรฐาน CATH-CPS009-B02 ของ Workshop และเวอร์ชันที่ใช้ตรวจ แยกเป็น `s1`–`s4` = ตารางสังเกตการณ์ 1–4 พร้อมเซลล์ต้นฉบับใน Excel ใช้แสดงผลเป็นฟอร์มเดิมได้
  - `signatures`: ลายเซ็นพร้อมรูป (`image` เป็น data URL)
  - `issues`: ปัญหาของ Audit นี้
  - `timing`: ผลจับเวลา
  - `audit_time`: เวลาเริ่ม–ส่ง, นาที, อยู่ในช่วงเวลาหรือไม่, นาทีครบหรือไม่
  - `plan`: แผนที่ผูกกับ Audit นี้
- `issues[]`: ปัญหาทั้งหมด พร้อมสถานะ G/B/R (`gbr`) และ `detail` (รวมรูปถ่ายเป็น `data_url`)
- `retention`: ผลการล้างข้อมูลรอบนี้

## การล้างข้อมูลในแอป PJO

- แอปเก็บข้อมูลไว้แค่ **2 วัน** ประวัติทั้งหมดอยู่ในระบบ CPS
- Audit, ปัญหา, ไฟล์รูปและลายเซ็น และบันทึกการเปลี่ยนแปลงที่เก่ากว่า 2 วัน จะถูกล้าง **เฉพาะรายการที่ CPS ได้รับแล้ว** ดูจาก `ack` หรือจากการดึงครั้งก่อนหน้า
- ไฟล์ใน Drive ถูกย้ายไปถังขยะ กู้คืนได้ 30 วัน
- **แผนตรวจไม่ถูกล้าง** และยังแสดงสีผลตรวจเดิม
- CPS จึงต้องเก็บข้อมูลที่ดึงไปแล้วเอง (upsert ตาม `audit.id` และ `issue.id`)
