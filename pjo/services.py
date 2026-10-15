"""Business rules. Views stay thin and call these functions inside transactions."""
import base64
import hashlib
import uuid
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import (
    SIGNATURE_SCOPE, Attachment, Audit, AuditRevision, AuditStatus, Counter, Issue, IssueEvent,
    IssueOccurrence, IssueStatus, IssueType, ISSUE_TRANSITIONS, MajorFollowUp, Mark, ProcessedOp,
    S3Answer, S4Review, Signature, SignatureRole, Suggestion, SystemSetting, TimingLap, TimingSession,
    TrailEntry, canonical_hash,
)


class RuleError(Exception):
    """A business rule rejected the request. Message is shown to the user."""

    def __init__(self, message, code="rule", extra=None):
        super().__init__(message)
        self.code = code
        self.extra = extra or {}


# ------------------------------------------------------------------ helpers
def next_number(name, prefix):
    with transaction.atomic():
        c, _ = Counter.objects.select_for_update().get_or_create(name=name)
        c.value += 1
        c.save()
        return f"{prefix}{c.value:05d}"


def new_audit_no(date):
    return next_number(f"audit-{date:%Y}", f"PJO-{date:%Y}-")


def new_issue_no():
    y = timezone.localdate().year
    return next_number(f"issue-{y}", f"ISS-{y}-")


def trail(user, action, audit=None, issue=None, **data):
    TrailEntry.objects.create(user=user if user and user.is_authenticated else None, action=action, audit=audit, issue=issue, data=data)


def private_path(*parts):
    p = Path(settings.PRIVATE_MEDIA_ROOT).joinpath(*parts)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


# ------------------------------------------------------------------ audit creation
HEADER_FIELDS = [
    "audit_date", "shift", "group", "line", "station", "model", "employee_name", "tlgl_name",
    "ois_revision", "ois_url", "ois_current", "standard_time_s", "standard_time_source",
    "takt_time_s", "takt_time_source",
]


def create_audit(user, template, header, plan=None):
    if template.status != "published":
        raise RuleError("ใช้ได้เฉพาะแม่แบบที่ Published แล้ว")
    date = header.get("audit_date") or timezone.localdate()
    a = Audit(
        audit_no=new_audit_no(date), template=template, snapshot=template.content,
        workshop=template.workshop, auditor=user, created_by=user, audit_date=date, plan=plan,
    )
    for f in HEADER_FIELDS:
        if f in header and f != "audit_date":
            setattr(a, f, header[f] if header[f] is not None else getattr(a, f))
    for fk in ("team", "employee", "tlgl_user"):
        if header.get(fk):
            setattr(a, fk, header[fk])
    if a.employee and not a.employee_name:
        a.employee_name = a.employee.name
    if a.team and not a.group:
        a.group = a.team.group
    if a.team and not a.line:
        a.line = a.team.line
    a.save()
    trail(user, "audit.create", audit=a, template=template.label)
    return a


def change_template(user, audit, template):
    """Changing workshop/template after answers exist would map answers onto the wrong items."""
    if audit.template_id == template.id:
        return audit
    has_data = (audit.marks.exists() or audit.s3_answers.exists() or audit.s4_reviews.exists()
                or audit.suggestions.exists() or audit.timings.exists() or audit.issues.exists())
    if has_data:
        raise RuleError("เปลี่ยน Workshop/แม่แบบไม่ได้ เพราะมีผลตรวจแล้ว ให้ยกเลิก Audit นี้และเริ่ม Audit ใหม่", "template_locked")
    audit.template = template
    audit.snapshot = template.content
    audit.workshop = template.workshop
    audit.save()
    trail(user, "audit.template_changed", audit=audit, template=template.label)
    return audit


# ------------------------------------------------------------------ serialisation
def audit_data(audit):
    """Full data of an audit, grouped by sheet. Used for hashing signatures, revisions and exports."""
    marks = {}
    for m in audit.marks.all().order_by("item_key", "occurrence"):
        marks.setdefault(m.item_key, {})[str(m.occurrence)] = m.value
    s1 = {k: v for k, v in marks.items() if k.startswith("S1-")}
    s2 = {k: v.get("0") for k, v in marks.items() if k.startswith("S2-")}
    timing = [timing_summary(s) for s in audit.timings.filter(saved=True, discarded=False)]
    s3 = {a.item_key: {"answer": a.employee_answer, "before": a.before, "coaching": a.coaching, "after": a.after}
          for a in audit.s3_answers.all().order_by("item_key")}
    sugg = [{"id": s.client_id, "description": s.description, "suggestion": s.suggestion, "owner": s.owner_name}
            for s in audit.suggestions.all().order_by("id")]
    s4 = [{"id": r.client_id, "case": r.case_key, "text": r.case_text, "real": r.is_real_event, "answer": r.employee_answer,
           "coaching": r.coaching, "result": r.result, "improvement": r.improvement} for r in audit.s4_reviews.all().order_by("id")]
    header = {f: str(getattr(audit, f) or "") for f in HEADER_FIELDS}
    header.update(employee=audit.employee_id, team=audit.team_id, template=audit.template_id)
    return {"header": header, "s1": {"marks": s1, "timing": timing}, "s2": s2, "s3": {"answers": s3, "suggestions": sugg}, "s4": s4}


def scope_data(audit, role, followup=None):
    data = audit_data(audit)
    scope = SIGNATURE_SCOPE[role]
    if scope == ["recert"]:
        f = followup
        return {"followup": f.id, "item": f.item_key, "occurrence": f.occurrence, "training": f.training_detail,
                "recert_by": f.recert_by, "recert_result": f.recert_result, "revision": audit.revision}
    out = {k: data[k] for k in scope}
    out["audit_no"] = audit.audit_no
    out["revision"] = audit.revision
    return out


def active_signatures(audit):
    return audit.signatures.filter(superseded_at__isnull=True)


def locked_sheets(audit):
    locked = set()
    for s in active_signatures(audit).filter(followup__isnull=True):
        locked.update(SIGNATURE_SCOPE[s.role])
    if audit.status in (AuditStatus.COMPLETED, AuditStatus.CANCELLED):
        locked.update(["header", "s1", "s2", "s3", "s4"])
    return locked


def ensure_editable(audit, sheet):
    if audit.status == AuditStatus.CANCELLED:
        raise RuleError("Audit นี้ถูกยกเลิกแล้ว", "cancelled")
    if sheet in locked_sheets(audit):
        raise RuleError("ส่วนนี้ลงนามแล้ว หากต้องแก้ไขให้กด “ขอแก้ไขหลังลงนาม” และระบุเหตุผล", "locked")


def touch_in_progress(audit):
    if audit.status == AuditStatus.DRAFT:
        audit.status = AuditStatus.IN_PROGRESS
        audit.save(update_fields=["status", "updated_at"])


# ------------------------------------------------------------------ autosave ops
def apply_ops(audit, user, ops):
    """Apply a batch of autosave ops. Each op is idempotent by `op_id`.
    Returns per-op results: ok / conflict / error with the current server value."""
    results = []
    for op in ops:
        op_id = str(op.get("op_id") or "")
        done = ProcessedOp.objects.filter(op_id=op_id).first() if op_id else None
        if done:
            results.append({**done.response, "op_id": op_id, "duplicate": True})
            continue
        try:
            with transaction.atomic():
                res = _apply_op(audit, user, op)
                res = {"op_id": op_id, "status": "ok", **res}
                if op_id:
                    ProcessedOp.objects.create(op_id=op_id, audit=audit, response=res)
        except RuleError as e:
            res = {"op_id": op_id, "status": "conflict" if e.code == "conflict" else "error", "code": e.code,
                   "message": str(e), **e.extra}
        results.append(res)
    audit.refresh_from_db()
    return results


def _apply_op(audit, user, op):
    t = op.get("type")
    if t == "mark":
        return _op_mark(audit, user, op)
    if t == "header":
        return _op_header(audit, user, op)
    if t == "s3":
        return _op_s3(audit, user, op)
    if t == "suggestion":
        return _op_suggestion(audit, user, op)
    if t == "s4":
        return _op_s4(audit, user, op)
    if t == "followup":
        return _op_followup(audit, user, op)
    raise RuleError(f"ไม่รู้จักคำสั่ง {t}")


def _op_mark(audit, user, op):
    key, occ, value = op["item_key"], int(op.get("occurrence") or 0), op.get("value") or ""
    items = audit.items()
    item = items.get(key)
    if not item or item["sheet"] not in ("s1", "s2"):
        raise RuleError("ไม่พบข้อนี้ในมาตรฐานของ Audit")
    ensure_editable(audit, item["sheet"])
    if value not in ("", "pass", "fail", "na"):
        raise RuleError("ค่าไม่ถูกต้อง")
    if item["sheet"] == "s1":
        n = audit.snapshot["s1"].get("frequency_count") or 12
        if not 1 <= occ <= n:
            raise RuleError("ครั้งที่สังเกตไม่ถูกต้อง")
        if value == "na" and not item.get("allow_na"):
            raise RuleError("ข้อนี้ไม่อนุญาต N/A")
    else:
        occ = 0
        if value == "na":
            raise RuleError("ตาราง 2 ใช้เฉพาะ √ / × ตามหมายเหตุของแบบฟอร์ม")
    cur = Mark.objects.select_for_update().filter(audit=audit, item_key=key, occurrence=occ).first()
    cur_val = cur.value if cur else ""
    if "prev" in op and (op["prev"] or "") != cur_val:
        raise RuleError("มีผู้อื่นบันทึกช่องนี้ไปก่อนแล้ว", "conflict", {"current": cur_val,
                        "by": cur.recorded_by.get_full_name() or cur.recorded_by.username if cur else ""})
    if value == "":
        if cur:
            cur.delete()
    elif cur:
        cur.value, cur.recorded_by, cur.recorded_at, cur.revision = value, user, timezone.now(), audit.revision
        cur.save()
    else:
        Mark.objects.create(audit=audit, item_key=key, occurrence=occ, value=value, recorded_by=user, revision=audit.revision)
    if cur_val == "fail" and value != "fail":
        # keep the issue; record that the mark changed
        o = IssueOccurrence.objects.filter(origin_key=origin_key(audit, key, occ)).first()
        if o:
            o.mark_changed_note = f"ผลตรวจถูกเปลี่ยนจาก × เป็น {value or 'ว่าง'} โดย {user} {timezone.localtime():%d/%m/%Y %H:%M}"
            o.save()
            IssueEvent.objects.create(issue=o.issue, action="mark_changed", comment=o.mark_changed_note, user=user)
    touch_in_progress(audit)
    trail(user, "mark", audit=audit, item=key, occurrence=occ, old=cur_val, new=value)
    needs_issue = value == "fail" and not IssueOccurrence.objects.filter(origin_key=origin_key(audit, key, occ)).exists()
    return {"value": value, "needs_issue": needs_issue, "recorded_at": timezone.now().isoformat()}


def _op_header(audit, user, op):
    ensure_editable(audit, "header")
    base = op.get("lock_version")
    a = Audit.objects.select_for_update().get(pk=audit.pk)
    if base is not None and int(base) != a.lock_version:
        raise RuleError("ข้อมูลส่วนหัวถูกแก้ไขโดยผู้อื่น กรุณาโหลดใหม่", "conflict", {"lock_version": a.lock_version})
    fields = op.get("fields", {})
    changed = {}
    for f, v in fields.items():
        if f not in HEADER_FIELDS:
            continue
        if f in ("standard_time_s", "takt_time_s"):
            v = Decimal(str(v)) if v not in ("", None) else None
        if f == "audit_date" and not v:
            continue
        old = getattr(a, f)
        if str(old or "") != str(v or ""):
            changed[f] = [str(old or ""), str(v or "")]
            setattr(a, f, v if v is not None else ("" if f not in ("standard_time_s", "takt_time_s") else None))
    if changed:
        a.lock_version += 1
        a.save()
        trail(user, "header", audit=a, changed=changed)
    touch_in_progress(a)
    return {"lock_version": a.lock_version}


def _op_s3(audit, user, op):
    ensure_editable(audit, "s3")
    key = op["item_key"]
    if audit.items().get(key, {}).get("sheet") != "s3":
        raise RuleError("ไม่พบคำถามนี้")
    ans, _ = S3Answer.objects.select_for_update().get_or_create(audit=audit, item_key=key)
    field = op["field"]
    if field not in ("employee_answer", "before", "coaching", "after"):
        raise RuleError("ช่องไม่ถูกต้อง")
    val = op.get("value") or ""
    if field in ("before", "after") and val not in ("", "pass", "fail"):
        raise RuleError("ค่าไม่ถูกต้อง")
    cur = getattr(ans, field)
    if "prev" in op and (op["prev"] or "") != cur:
        raise RuleError("มีผู้อื่นแก้ไขช่องนี้แล้ว", "conflict", {"current": cur})
    setattr(ans, field, val)
    ans.evaluator, ans.evaluated_at = user, timezone.now()
    ans.save()
    touch_in_progress(audit)
    trail(user, "s3", audit=audit, item=key, field=field, old=cur, new=val)
    return {"evaluated_at": ans.evaluated_at.isoformat()}


def _op_suggestion(audit, user, op):
    ensure_editable(audit, "s3")
    cid = op["client_id"]
    s = Suggestion.objects.filter(client_id=cid).first()
    if s and s.audit_id != audit.id:
        raise RuleError("รหัสรายการซ้ำ")
    if op.get("delete"):
        if s:
            s.delete()
        return {}
    if not s:
        s = Suggestion(audit=audit, client_id=cid, created_by=user)
    for f in ("description", "suggestion", "owner_name"):
        if f in op.get("fields", {}):
            setattr(s, f, op["fields"][f])
    s.save()
    touch_in_progress(audit)
    return {"id": s.id}


def _op_s4(audit, user, op):
    ensure_editable(audit, "s4")
    cid = op["client_id"]
    r = S4Review.objects.filter(client_id=cid).first()
    if r and r.audit_id != audit.id:
        raise RuleError("รหัสรายการซ้ำ")
    if op.get("delete"):
        if r:
            if r.issue_id:
                raise RuleError("รายการนี้สร้างปัญหาแล้ว ลบไม่ได้")
            r.delete()
        return {}
    if not r:
        r = S4Review(audit=audit, client_id=cid, created_by=user)
    f = op.get("fields", {})
    if "case_key" in f:
        if f["case_key"] and audit.items().get(f["case_key"], {}).get("sheet") != "s4":
            raise RuleError("ไม่พบกรณีนี้ในมาตรฐาน")
        r.case_key = f["case_key"]
    for k in ("case_text", "employee_answer", "coaching", "improvement"):
        if k in f:
            setattr(r, k, f[k])
    if "result" in f:
        if f["result"] not in ("", "pass", "fail"):
            raise RuleError("ค่าไม่ถูกต้อง")
        r.result = f["result"]
    if "is_real_event" in f:
        r.is_real_event = bool(f["is_real_event"])
    r.save()
    touch_in_progress(audit)
    return {"id": r.id}


def _op_followup(audit, user, op):
    f = MajorFollowUp.objects.select_for_update().get(pk=op["id"], audit=audit)
    if active_signatures(audit).filter(followup=f).exists():
        raise RuleError("การรับรองใหม่ลงนามแล้ว แก้ไขไม่ได้")
    fields = op.get("fields", {})
    for k in ("supervisor_notified", "immediate_action", "training_by", "training_detail", "recert_by", "recert_result"):
        if k in fields:
            setattr(f, k, fields[k])
    for k in ("training_at", "recert_at"):
        if k in fields:
            setattr(f, k, fields[k] or None)
    if f.stage != MajorFollowUp.Stage.RECERTIFIED:
        # RECERTIFIED is only set when both re-certification signatures exist
        f.stage = MajorFollowUp.Stage.TRAINED if f.training_detail.strip() else MajorFollowUp.Stage.OPEN
    f.save()
    trail(user, "followup", audit=audit, followup=f.id, fields=list(fields))
    return {"stage": f.stage}


# ------------------------------------------------------------------ issues
def origin_key(audit, item_key, occurrence):
    return f"A{audit.id}:{item_key}:{occurrence}"


ITEM_TYPE = {"s2": IssueType.IMPROVEMENT, "s3": IssueType.UNDERSTANDING, "s4": IssueType.REAL_EVENT}


def record_finding(audit, user, *, sheet, item_key="", occurrence=None, title, description="", priority="",
                   owner=None, owner_name="", due_date=None, link_issue=None, client_id=None, origin=None):
    """Create an issue for a finding, or link it to an existing issue. Idempotent by
    `client_id` and by origin (audit+item+occurrence), so double taps and re-sync never duplicate."""
    if client_id:
        existing = Issue.objects.filter(client_id=client_id).first()
        if existing:
            return existing, False
    origin = origin or (origin_key(audit, item_key, occurrence or 0) if item_key else None)
    if origin:
        occ = IssueOccurrence.objects.filter(origin_key=origin).select_related("issue").first()
        if occ:
            return occ.issue, False
    item = audit.items().get(item_key, {}) if item_key else {}
    if sheet == "s1":
        itype = IssueType.MAJOR if item.get("severity") == "major" else IssueType.MINOR
    else:
        itype = ITEM_TYPE.get(sheet, IssueType.OTHER)
    created = False
    if isinstance(due_date, str):
        try:
            due_date = date.fromisoformat(due_date) if due_date else None
        except ValueError:
            raise RuleError("รูปแบบวันที่กำหนดเสร็จไม่ถูกต้อง")
    if link_issue is not None:
        issue = link_issue
        if issue.workshop_id != audit.workshop_id:
            raise RuleError("เชื่อมได้เฉพาะปัญหาใน Workshop เดียวกัน")
        if issue.status == IssueStatus.CLOSED:
            transition_issue(issue, user, "reopened", comment=f"พบซ้ำใน {audit.audit_no}")
    else:
        issue = Issue.objects.create(
            issue_no=new_issue_no(), client_id=client_id, audit=audit, workshop=audit.workshop, team=audit.team,
            station=audit.station, model=audit.model, employee=audit.employee, sheet=sheet, item_key=item_key,
            item_code=item.get("code") or (f"ข้อ {item.get('no')}" if item.get("no") else ""), issue_type=itype,
            priority=priority, title=title[:255], description=description, owner=owner, owner_name=owner_name,
            due_date=due_date or None, created_by=user,
            status=IssueStatus.ASSIGNED if (owner or owner_name) else IssueStatus.OPEN,
        )
        IssueEvent.objects.create(issue=issue, action="created", to_status=issue.status, user=user,
                                  comment=f"สร้างจาก {audit.audit_no} {item.get('code') or item_key} ครั้งที่ {occurrence or '-'}")
        created = True
    try:
        IssueOccurrence.objects.create(
            issue=issue, audit=audit, sheet=sheet, item_key=item_key, occurrence=occurrence, origin_key=origin,
            note=description, mark_value_at_finding="fail" if sheet in ("s1", "s2") else "", found_by=user,
        )
    except IntegrityError:
        raise RuleError("รายการนี้ถูกบันทึกปัญหาแล้ว", "duplicate")
    if not created:
        IssueEvent.objects.create(issue=issue, action="linked", user=user,
                                  comment=f"พบซ้ำใน {audit.audit_no} {item.get('code') or item_key} ครั้งที่ {occurrence or '-'}")
    if itype == IssueType.MAJOR and sheet == "s1":
        if not hasattr(issue, "major_followup"):
            MajorFollowUp.objects.create(audit=audit, issue=issue, item_key=item_key, occurrence=occurrence or 0)
    trail(user, "issue.finding", audit=audit, issue=issue, created=created, item=item_key, occurrence=occurrence)
    return issue, created


def transition_issue(issue, user, to, comment=""):
    frm = issue.status
    if to not in ISSUE_TRANSITIONS.get(frm, set()):
        raise RuleError(f"เปลี่ยนสถานะจาก {issue.status_th} เป็น {to} ไม่ได้")
    if to == "reopened" and not comment.strip():
        raise RuleError("ต้องระบุเหตุผลการเปิดใหม่")
    if to == "assigned" and not (issue.owner_id or issue.owner_name):
        raise RuleError("ต้องระบุผู้รับผิดชอบก่อนมอบหมาย")
    if to == "pending_verification" and not (issue.containment or issue.permanent_action):
        raise RuleError("ต้องบันทึกการแก้ไขก่อนส่งตรวจยืนยัน")
    if to == "closed":
        if not issue.effectiveness.strip():
            raise RuleError("ต้องบันทึกผลตรวจประสิทธิผลก่อนปิด")
        issue.verifier, issue.verified_at, issue.closed_at = user, timezone.now(), timezone.now()
    if to == "reopened":
        issue.closed_at = None
    issue.status = to
    issue.lock_version += 1
    issue.save()
    IssueEvent.objects.create(issue=issue, from_status=frm, to_status=to, action="transition", comment=comment, user=user)
    trail(user, "issue.transition", issue=issue, frm=frm, to=to)
    return issue


def gbr_mapping():
    """Admin-confirmed meaning of G/B/R. None until confirmed: the app then hides G/B/R."""
    return SystemSetting.get("gbr_mapping")


# ------------------------------------------------------------------ timing
def _d(x):
    return Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def laps_from_events(events):
    """Compute laps from raw stopwatch events using their timestamps (ms).
    Paused time is deducted and reported per lap, never silently."""
    laps, lap_start, paused_ms, pause_start, reasons = [], None, 0, None, []
    for e in events:
        t = float(e["t"])
        k = e["type"]
        if k == "start":
            lap_start, paused_ms, pause_start, reasons = t, 0, None, []
        elif k == "pause" and lap_start is not None and pause_start is None:
            pause_start = t
            reasons.append(e.get("reason", ""))
        elif k == "resume" and pause_start is not None:
            paused_ms += t - pause_start
            pause_start = None
        elif k in ("lap", "stop") and lap_start is not None:
            if pause_start is not None:
                paused_ms += t - pause_start
                pause_start = None
            gross = (t - lap_start) / 1000
            laps.append({"gross": gross, "paused": paused_ms / 1000, "net": gross - paused_ms / 1000, "pause_reasons": reasons})
            lap_start = t if k == "lap" else None
            paused_ms, reasons = 0, []
    return laps


def save_timing(audit, user, payload):
    ensure_editable(audit, "s1")
    key = payload["item_key"]
    item = audit.items().get(key)
    if not item or item.get("kind") != "timing":
        raise RuleError("ข้อนี้ไม่ใช่ข้อวัดเวลา")
    obs = int(payload["observation"])
    if not 1 <= obs <= (audit.snapshot["s1"].get("frequency_count") or 12):
        raise RuleError("ครั้งที่สังเกตไม่ถูกต้อง")
    cid = payload["client_id"]
    s = TimingSession.objects.filter(client_id=cid).first()
    if s and s.audit_id != audit.id:
        raise RuleError("รหัสการจับเวลาซ้ำ")
    if s and s.saved and not payload.get("final"):
        return s
    if not s:
        s = TimingSession(audit=audit, item_key=key, observation=obs, client_id=cid)
    events = payload.get("events", [])
    for e in events:
        e.setdefault("server_received", timezone.now().isoformat())
    s.events = events
    s.warnings = payload.get("warnings", [])
    s.observation = obs
    s.save()
    if payload.get("final"):
        computed = laps_from_events(events)
        overrides = {int(x["lap_no"]): x for x in payload.get("laps", [])}
        s.laps.all().delete()
        n = 0
        for i, c in enumerate(computed, start=1):
            o = overrides.get(i, {})
            n = i
            valid = o.get("valid", True)
            if not valid and not (o.get("invalid_reason") or "").strip():
                raise RuleError(f"รอบที่ {i} ถูกตั้งเป็นใช้ไม่ได้ ต้องระบุเหตุผล")
            if c["paused"] > 0 and not all((r or "").strip() for r in c["pause_reasons"]):
                raise RuleError(f"รอบที่ {i} มีการหยุดชั่วคราว ต้องระบุเหตุผล")
            TimingLap.objects.create(session=s, lap_no=i, seconds=_d(c["net"]), gross_seconds=_d(c["gross"]),
                                     paused_seconds=_d(c["paused"]), pause_reasons=c["pause_reasons"],
                                     valid=valid, invalid_reason=o.get("invalid_reason", ""))
        for m in payload.get("manual_laps", []):
            reason = (m.get("reason") or "").strip()
            if not reason:
                raise RuleError("เวลาที่กรอกเองต้องระบุเหตุผล")
            sec = Decimal(str(m["seconds"]))
            if sec <= 0:
                raise RuleError("เวลาต้องมากกว่า 0")
            n += 1
            TimingLap.objects.create(session=s, lap_no=n, seconds=_d(sec), gross_seconds=_d(sec), source="manual",
                                     manual_reason=reason, valid=m.get("valid", True), invalid_reason=m.get("invalid_reason", ""))
        if not s.laps.exists():
            raise RuleError("ยังไม่มีรอบจับเวลา")
        # one saved session per item/observation: older saved ones are kept but marked replaced
        for old in TimingSession.objects.filter(audit=audit, item_key=key, observation=obs, saved=True, discarded=False).exclude(pk=s.pk):
            old.discarded, old.discard_reason = True, f"แทนที่ด้วยการจับเวลาใหม่ {timezone.localtime():%d/%m/%Y %H:%M}"
            old.save()
        s.saved, s.saved_by, s.saved_at = True, user, timezone.now()
        s.save()
        touch_in_progress(audit)
        trail(user, "timing.saved", audit=audit, item=key, observation=obs, summary=timing_summary(s))
    return s


def timing_summary(s):
    laps = list(s.laps.all())
    valid = [l for l in laps if l.valid]
    vals = [l.seconds for l in valid]
    a = s.audit
    out = {
        "id": s.id, "client_id": s.client_id, "item_key": s.item_key, "observation": s.observation,
        "laps": [{"lap_no": l.lap_no, "seconds": float(l.seconds), "gross": float(l.gross_seconds), "paused": float(l.paused_seconds),
                  "pause_reasons": l.pause_reasons, "source": l.source, "manual_reason": l.manual_reason, "valid": l.valid,
                  "invalid_reason": l.invalid_reason} for l in laps],
        "count_used": len(vals), "count_total": len(laps),
        "avg": float(sum(vals) / len(vals)) if vals else None,
        "min": float(min(vals)) if vals else None,
        "max": float(max(vals)) if vals else None,
        "warnings": s.warnings,
        "saved_at": s.saved_at.isoformat() if s.saved_at else None,
        "standard_time": float(a.standard_time_s) if a.standard_time_s is not None else None,
        "standard_time_source": a.standard_time_source,
        "takt_time": float(a.takt_time_s) if a.takt_time_s is not None else None,
        "takt_time_source": a.takt_time_source,
        # No approved acceptance rule exists in the source documents.
        "evaluation": "รอประเมิน",
    }
    return out


# ------------------------------------------------------------------ signatures
def required_signatures(audit):
    marks = audit.marks.filter(value="fail", item_key__startswith="S1-")
    items = audit.items()
    has_major = any(items.get(m.item_key, {}).get("severity") == "major" for m in marks)
    has_minor = any(items.get(m.item_key, {}).get("severity") == "minor" for m in marks)
    active = {s.role: s for s in active_signatures(audit).filter(followup__isnull=True)}
    labels = {l["role"]: l["text"] for l in audit.snapshot["s1"].get("labels", [])}
    s3sig = audit.snapshot["s3"]["signature"]["text"]
    rows = []

    def add(role, required, label, statement):
        rows.append({"role": role, "label": label, "required": required, "signature": active.get(role), "statement": statement})

    add("employee_major", has_major, labels.get("employee_major") or SignatureRole.EMPLOYEE_MAJOR.label,
        "ข้าพเจ้ารับทราบความผิดปกติหลักที่บันทึกในตาราง 1 ของ Audit นี้")
    add("employee_minor", has_minor, labels.get("employee_minor") or SignatureRole.EMPLOYEE_MINOR.label,
        "ข้าพเจ้ารับทราบความผิดปกติรองที่บันทึกในตาราง 1 ของ Audit นี้")
    add("employee_s3", True, "ลายเซ็นของพนักงาน (ระยะที่ 2)", "ข้าพเจ้ารับทราบผลการประเมินความเข้าใจเชิงลึกและการชี้แนะในตาราง 3")
    add("supervisor_s3", True, s3sig.split(":")[0].strip() if s3sig else SignatureRole.SUPERVISOR_S3.label,
        "ข้าพเจ้ารับรองว่าได้ประเมินและชี้แนะพนักงานตามตาราง 3")
    add("auditor", True, "ผู้ตรวจสอบ", "ข้าพเจ้ารับรองว่าผลตรวจ PJO ทั้ง 4 ตารางใน Audit นี้ถูกต้องตามที่สังเกตจริง")
    return rows


def recert_signatures(followup):
    active = {s.role: s for s in followup.signatures.filter(superseded_at__isnull=True)}
    return [
        {"role": "recertifier", "label": "ผู้รับรองใหม่", "signature": active.get("recertifier"),
         "statement": "ข้าพเจ้าได้สังเกตงานซ้ำหลังการฝึกอบรมและบันทึกผลตามจริง (โปรแกรมไม่ใช่การอนุญาตให้กลับเข้าทำงาน)"},
        {"role": "employee_recert", "label": "ลายเซ็นยืนยันความผิดปกติหลักหลังการรับรองใหม่", "signature": active.get("employee_recert"),
         "statement": "ข้าพเจ้ารับทราบผลการรับรองใหม่หลังความผิดปกติหลัก"},
    ]


def save_signature_image(audit, data_url):
    if not data_url or not data_url.startswith("data:image/png;base64,"):
        raise RuleError("ไม่พบภาพลายเซ็น")
    raw = base64.b64decode(data_url.split(",", 1)[1])
    if len(raw) < 200:
        raise RuleError("ลายเซ็นว่าง กรุณาเซ็นก่อนยืนยัน")
    name = f"{uuid.uuid4().hex}.png"
    rel = Path("signatures") / audit.audit_no / name
    p = private_path(str(rel))
    p.write_bytes(raw)
    return str(rel), hashlib.sha256(raw).hexdigest()


@transaction.atomic
def sign(audit, user, *, role, data_url, client_id, signer_name, signer_code="", identity_method, witness=None,
         followup=None, strokes=0):
    audit = Audit.objects.select_for_update().get(pk=audit.pk)
    existing = Signature.objects.filter(client_id=client_id).first()
    if existing:
        return existing
    if audit.status == AuditStatus.CANCELLED:
        raise RuleError("Audit ถูกยกเลิกแล้ว")
    if int(strokes or 0) < 1:
        raise RuleError("ลายเซ็นว่าง กรุณาเซ็นก่อนยืนยัน")
    if role in ("employee_recert", "recertifier"):
        if followup is None:
            raise RuleError("ไม่พบรายการรับรองใหม่")
        if not (followup.training_detail and followup.recert_result):
            raise RuleError("ต้องบันทึกการฝึกอบรมและผลการสังเกตซ้ำก่อนลงนามรับรองใหม่")
        rows = recert_signatures(followup)
    else:
        if audit.status not in (AuditStatus.PENDING_SIGNATURES, AuditStatus.AMENDED):
            raise RuleError("ต้องกด “ตรวจเสร็จ ส่งลงนาม” ก่อน")
        rows = required_signatures(audit)
    row = next((r for r in rows if r["role"] == role), None)
    if row is None:
        raise RuleError("บทบาทลงนามไม่ถูกต้อง")
    if row["signature"]:
        raise RuleError("บทบาทนี้ลงนามแล้ว")
    if identity_method == "login":
        if not signer_name:
            signer_name = user.get_full_name() or user.username
    elif identity_method == "employee_code_witnessed":
        if not signer_code:
            raise RuleError("ต้องระบุรหัสพนักงาน")
        from org.models import Employee
        emp = Employee.objects.filter(code=signer_code).first()
        if emp is None:
            raise RuleError("ไม่พบรหัสพนักงานนี้")
        if role in ("employee_major", "employee_minor", "employee_s3", "employee_recert") and audit.employee_id and emp.id != audit.employee_id:
            raise RuleError("รหัสพนักงานไม่ตรงกับพนักงานที่ถูกตรวจ")
        signer_name = emp.name
        witness = user
    else:
        raise RuleError("วิธีระบุตัวตนไม่ถูกต้อง")
    path, img_hash = save_signature_image(audit, data_url)
    sig = Signature.objects.create(
        audit=audit, audit_revision=audit.revision, role=role, followup=followup,
        signer_user=user if identity_method == "login" else None, signer_name=signer_name, signer_code=signer_code,
        identity_method=identity_method, witness=witness, statement=row["statement"], image_path=path,
        image_sha256=img_hash, data_hash=canonical_hash(scope_data(audit, role, followup)), client_id=client_id,
    )
    trail(user, "signature", audit=audit, role=role, signer=signer_name, method=identity_method, revision=audit.revision)
    if followup is not None:
        if all(r["signature"] or r["role"] == role for r in recert_signatures(followup)):
            followup.stage = MajorFollowUp.Stage.RECERTIFIED
            followup.save()
    else:
        refresh_completion(audit)
    return sig


def refresh_completion(audit):
    rows = required_signatures(audit)
    if all(r["signature"] for r in rows if r["required"]) and audit.status in (AuditStatus.PENDING_SIGNATURES, AuditStatus.AMENDED):
        audit.status = AuditStatus.COMPLETED
        audit.completed_at = timezone.now()
        audit.save()
        trail(None, "audit.completed", audit=audit, revision=audit.revision)


def submit_for_signatures(audit, user):
    if audit.status not in (AuditStatus.DRAFT, AuditStatus.IN_PROGRESS, AuditStatus.AMENDED):
        raise RuleError("สถานะปัจจุบันส่งลงนามไม่ได้")
    if not audit.marks.filter(item_key__startswith="S1-").exists():
        raise RuleError("ยังไม่มีผลการสังเกตในตาราง 1")
    if not audit.ois_current:
        raise RuleError("กรุณาตอบการตรวจสอบ OIS ฉบับปัจจุบัน (Yes/No) ก่อนส่งลงนาม")
    fails = audit.marks.filter(value="fail")
    unlogged = [f"{m.item_key} ครั้งที่ {m.occurrence}" for m in fails
                if not IssueOccurrence.objects.filter(origin_key=origin_key(audit, m.item_key, m.occurrence)).exists()]
    if unlogged:
        raise RuleError("ยังมีช่อง × ที่ไม่ได้บันทึกปัญหา: " + ", ".join(unlogged[:8]), "unlogged", {"items": unlogged})
    audit.status = AuditStatus.PENDING_SIGNATURES
    audit.submitted_at = timezone.now()
    audit.save()
    trail(user, "audit.submitted", audit=audit)
    refresh_completion(audit)
    return audit


@transaction.atomic
def amend(audit, user, reason, sheets):
    audit = Audit.objects.select_for_update().get(pk=audit.pk)
    if not reason.strip():
        raise RuleError("ต้องระบุเหตุผลการแก้ไข")
    valid = {"header", "s1", "s2", "s3", "s4"}
    sheets = [s for s in sheets if s in valid]
    if not sheets:
        raise RuleError("เลือกส่วนที่ต้องแก้ไข")
    if audit.status == AuditStatus.CANCELLED:
        raise RuleError("Audit ถูกยกเลิกแล้ว")
    if not active_signatures(audit).filter(followup__isnull=True).exists():
        raise RuleError("ยังไม่มีการลงนาม แก้ไขได้ตามปกติ")
    AuditRevision.objects.create(audit=audit, revision=audit.revision, reason=reason, affected=sheets,
                                 data_before=audit_data(audit), created_by=user)
    now = timezone.now()
    for s in active_signatures(audit).filter(followup__isnull=True):
        if set(SIGNATURE_SCOPE[s.role]) & set(sheets):
            s.superseded_at = now
            s.superseded_reason = f"แก้ไข Rev {audit.revision + 1}: {reason}"
            s.save()
    audit.revision += 1
    audit.status = AuditStatus.AMENDED
    audit.completed_at = None
    audit.save()
    trail(user, "audit.amended", audit=audit, reason=reason, sheets=sheets, revision=audit.revision)
    return audit


def cancel_audit(audit, user, reason):
    if not reason.strip():
        raise RuleError("ต้องระบุเหตุผลการยกเลิก")
    if audit.status == AuditStatus.COMPLETED:
        raise RuleError("Audit ที่ลงนามครบแล้วยกเลิกไม่ได้ ให้ใช้การแก้ไขหลังลงนาม")
    audit.status = AuditStatus.CANCELLED
    audit.cancel_reason = reason
    audit.save()
    trail(user, "audit.cancelled", audit=audit, reason=reason)


# ------------------------------------------------------------------ attachments
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"}


def save_attachment(user, upload, *, audit=None, issue=None, purpose="evidence", note=""):
    if upload.size > settings.MAX_ATTACHMENT_MB * 1024 * 1024:
        raise RuleError(f"ไฟล์ใหญ่เกิน {settings.MAX_ATTACHMENT_MB} MB")
    ctype = upload.content_type or "application/octet-stream"
    if ctype not in ALLOWED_TYPES:
        raise RuleError("รองรับเฉพาะรูปภาพหรือ PDF")
    ext = Path(upload.name).suffix.lower()[:8]
    rel = Path("attachments") / f"{timezone.now():%Y%m}" / f"{uuid.uuid4().hex}{ext}"
    p = private_path(str(rel))
    with open(p, "wb") as fh:
        for chunk in upload.chunks():
            fh.write(chunk)
    att = Attachment.objects.create(audit=audit or (issue.audit if issue else None), issue=issue, purpose=purpose,
                                    path=str(rel), original_name=upload.name[:255], content_type=ctype, size=upload.size,
                                    note=note, uploaded_by=user)
    trail(user, "attachment", audit=att.audit, issue=issue, name=upload.name)
    return att
