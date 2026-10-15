import hashlib
import json
import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

from org.models import Employee, Team, Workshop

User = settings.AUTH_USER_MODEL


# ---------------------------------------------------------------- templates
class TemplateStatus(models.TextChoices):
    DRAFT = "draft", "Draft"
    PUBLISHED = "published", "Published"
    RETIRED = "retired", "Retired"


class PJOTemplate(models.Model):
    """One version of the PJO standard for one workshop. `content` holds the 4
    sheets exactly as extracted from the source form (see tools/extract_templates.py).
    Published versions are immutable; edits create a new Draft version."""

    workshop = models.ForeignKey(Workshop, on_delete=models.PROTECT, related_name="templates")
    version = models.PositiveIntegerField()
    status = models.CharField(max_length=12, choices=TemplateStatus.choices, default=TemplateStatus.DRAFT)
    content = models.JSONField()
    source_file = models.CharField(max_length=255, blank=True)
    source_sha = models.CharField(max_length=64, blank=True, help_text="SHA-256 ของแม่แบบที่ดึงจากไฟล์ต้นฉบับ")
    change_note = models.TextField(blank=True)
    created_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    published_at = models.DateTimeField(null=True, blank=True)
    published_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    retired_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = [("workshop", "version")]
        ordering = ["workshop__code", "-version"]

    def __str__(self):
        return f"{self.workshop.code} v{self.version} ({self.status})"

    @property
    def label(self):
        return f"{self.content.get('form_code', 'PJO')} {self.workshop.code} v{self.version}"

    def item_index(self):
        return build_item_index(self.content)


def build_item_index(content):
    """key -> item dict for every answerable item of a template snapshot."""
    idx = {}
    for i in content["s1"]["items"]:
        idx[i["key"]] = {**i, "sheet": "s1"}
    for s in content["s2"]["sections"]:
        for i in s["items"]:
            idx[i["key"]] = {**i, "sheet": "s2", "section": s["code"]}
    for q in content["s3"]["questions"]:
        idx[q["key"]] = {**q, "sheet": "s3"}
    for c in content["s4"]["cases"]:
        idx[c["key"]] = {**c, "sheet": "s4", "text": c["case"]}
    return idx


class PendingItem(models.Model):
    """Something in the standard that needs an owner's decision. The app never
    guesses these; it shows them until an Admin records a resolution."""

    class Status(models.TextChoices):
        PENDING = "pending", "รอยืนยัน"
        RESOLVED = "resolved", "ยืนยันแล้ว"

    code = models.CharField(max_length=60, unique=True)
    title = models.CharField(max_length=255)
    detail = models.TextField()
    workshops = models.CharField(max_length=255, blank=True, help_text="รหัส workshop ที่เกี่ยวข้อง คั่นด้วย ,")
    sources = models.JSONField(default=list)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    resolution = models.TextField(blank=True)
    resolved_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["status", "code"]


class SystemSetting(models.Model):
    """Key/value settings confirmed by an Admin, e.g. the G/B/R meaning."""

    key = models.CharField(max_length=60, unique=True)
    value = models.JSONField(null=True, blank=True)
    updated_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    updated_at = models.DateTimeField(auto_now=True)

    @classmethod
    def get(cls, key, default=None):
        s = cls.objects.filter(key=key).first()
        return default if s is None or s.value is None else s.value


# ---------------------------------------------------------------- plans
class AuditPlan(models.Model):
    workshop = models.ForeignKey(Workshop, on_delete=models.PROTECT)
    team = models.ForeignKey(Team, null=True, blank=True, on_delete=models.SET_NULL)
    station = models.CharField(max_length=80, blank=True)
    employee = models.ForeignKey(Employee, null=True, blank=True, on_delete=models.SET_NULL)
    planned_date = models.DateField()
    auditor = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    note = models.CharField(max_length=255, blank=True)
    cancelled = models.BooleanField(default=False)
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["planned_date"]


# ---------------------------------------------------------------- audits
class AuditStatus(models.TextChoices):
    DRAFT = "draft", "Draft"
    IN_PROGRESS = "in_progress", "In Progress"
    PENDING_SIGNATURES = "pending_signatures", "Pending Signatures"
    COMPLETED = "completed", "Completed"
    AMENDED = "amended", "Amended"
    CANCELLED = "cancelled", "Cancelled"


AUDIT_STATUS_TH = {
    "draft": "ร่าง",
    "in_progress": "กำลังตรวจ",
    "pending_signatures": "รอลงนาม",
    "completed": "ตรวจและลงนามครบ",
    "amended": "แก้ไขหลังลงนาม (รอลงนามใหม่)",
    "cancelled": "ยกเลิก",
}


class Audit(models.Model):
    audit_no = models.CharField("เลข Audit", max_length=40, unique=True)
    template = models.ForeignKey(PJOTemplate, on_delete=models.PROTECT, related_name="audits")
    snapshot = models.JSONField(help_text="สำเนามาตรฐานที่ใช้ตรวจ ณ เวลาที่สร้าง Audit")
    workshop = models.ForeignKey(Workshop, on_delete=models.PROTECT, related_name="audits")
    plan = models.ForeignKey(AuditPlan, null=True, blank=True, on_delete=models.SET_NULL, related_name="audits")
    audit_date = models.DateField("วันที่")
    shift = models.CharField("กะ", max_length=20, blank=True)
    group = models.CharField("Group", max_length=80, blank=True)
    team = models.ForeignKey(Team, null=True, blank=True, on_delete=models.SET_NULL)
    line = models.CharField("Line", max_length=80, blank=True)
    station = models.CharField("Station", max_length=80, blank=True)
    model = models.CharField("Model", max_length=80, blank=True)
    employee = models.ForeignKey(Employee, null=True, blank=True, on_delete=models.PROTECT, related_name="audits")
    employee_name = models.CharField("พนักงานที่ถูกตรวจ", max_length=160, blank=True)
    auditor = models.ForeignKey(User, on_delete=models.PROTECT, related_name="pjo_audits")
    tlgl_name = models.CharField("TL/GL", max_length=160, blank=True)
    tlgl_user = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    ois_revision = models.CharField("OIS/WES Revision", max_length=80, blank=True)
    ois_url = models.URLField("ลิงก์ OIS/WES", max_length=500, blank=True)
    ois_current = models.CharField("OIS เป็นฉบับปัจจุบัน", max_length=5, blank=True)  # "yes" / "no" / ""
    standard_time_s = models.DecimalField("Standard Time (วินาที)", max_digits=9, decimal_places=2, null=True, blank=True)
    standard_time_source = models.CharField(max_length=255, blank=True)
    takt_time_s = models.DecimalField("Takt Time (วินาที)", max_digits=9, decimal_places=2, null=True, blank=True)
    takt_time_source = models.CharField(max_length=255, blank=True)
    status = models.CharField(max_length=20, choices=AuditStatus.choices, default=AuditStatus.DRAFT)
    revision = models.PositiveIntegerField(default=1)
    lock_version = models.PositiveIntegerField(default=1)
    cancel_reason = models.TextField(blank=True)
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-audit_date", "-id"]

    def __str__(self):
        return self.audit_no

    @property
    def status_th(self):
        return AUDIT_STATUS_TH.get(self.status, self.status)

    @property
    def is_locked_for_edit(self):
        return self.status in (AuditStatus.COMPLETED, AuditStatus.CANCELLED)

    def items(self):
        return build_item_index(self.snapshot)


class Mark(models.Model):
    """A √ / × / N/A in sheet 1 (per item and observation occurrence) or sheet 2 (occurrence 0)."""

    VALUES = [("pass", "√"), ("fail", "×"), ("na", "N/A")]
    audit = models.ForeignKey(Audit, on_delete=models.CASCADE, related_name="marks")
    item_key = models.CharField(max_length=30)
    occurrence = models.PositiveSmallIntegerField(default=0)
    value = models.CharField(max_length=5, choices=VALUES)
    recorded_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    recorded_at = models.DateTimeField(default=timezone.now)
    revision = models.PositiveIntegerField(default=1)

    class Meta:
        unique_together = [("audit", "item_key", "occurrence")]


class S3Answer(models.Model):
    audit = models.ForeignKey(Audit, on_delete=models.CASCADE, related_name="s3_answers")
    item_key = models.CharField(max_length=30)
    employee_answer = models.TextField(blank=True)
    before = models.CharField(max_length=5, blank=True)  # pass/fail/""
    coaching = models.TextField(blank=True)
    after = models.CharField(max_length=5, blank=True)
    evaluator = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    evaluated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = [("audit", "item_key")]


class Suggestion(models.Model):
    """Employee improvement suggestions (sheet 3 bottom table). Not an abnormality."""

    audit = models.ForeignKey(Audit, on_delete=models.CASCADE, related_name="suggestions")
    client_id = models.CharField(max_length=40, unique=True)
    description = models.TextField(blank=True)
    suggestion = models.TextField(blank=True)
    owner_name = models.CharField(max_length=160, blank=True)
    issue = models.ForeignKey("Issue", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)


class S4Review(models.Model):
    """Sheet 4: one reviewed case. Template cases are hypothetical scenarios; employees
    can add their own experience; `is_real_event` marks something that actually happened."""

    audit = models.ForeignKey(Audit, on_delete=models.CASCADE, related_name="s4_reviews")
    client_id = models.CharField(max_length=40, unique=True)
    case_key = models.CharField(max_length=30, blank=True)  # template case key, blank for own experience
    case_text = models.TextField(blank=True)
    is_real_event = models.BooleanField(default=False)
    employee_answer = models.TextField(blank=True)
    coaching = models.TextField(blank=True)
    result = models.CharField(max_length=5, blank=True)  # pass/fail/""
    improvement = models.TextField(blank=True)
    issue = models.ForeignKey("Issue", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    updated_at = models.DateTimeField(auto_now=True)


# ---------------------------------------------------------------- timing
class TimingSession(models.Model):
    """Stopwatch for the time-measurement item. `observation` is the PJO occurrence
    (1-12 on the paper form). Laps are the timed work cycles inside that observation."""

    audit = models.ForeignKey(Audit, on_delete=models.CASCADE, related_name="timings")
    item_key = models.CharField(max_length=30)
    observation = models.PositiveSmallIntegerField()
    client_id = models.CharField(max_length=40, unique=True)
    events = models.JSONField(default=list)  # raw start/lap/pause/resume/stop with client+server timestamps
    warnings = models.JSONField(default=list)  # clock jumps, gaps the auditor confirmed
    saved = models.BooleanField(default=False)
    saved_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    saved_at = models.DateTimeField(null=True, blank=True)
    discarded = models.BooleanField(default=False)
    discard_reason = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["observation", "id"]


class TimingLap(models.Model):
    session = models.ForeignKey(TimingSession, on_delete=models.CASCADE, related_name="laps")
    lap_no = models.PositiveSmallIntegerField()
    seconds = models.DecimalField(max_digits=9, decimal_places=2)
    gross_seconds = models.DecimalField(max_digits=9, decimal_places=2)
    paused_seconds = models.DecimalField(max_digits=9, decimal_places=2, default=0)
    pause_reasons = models.JSONField(default=list)
    source = models.CharField(max_length=10, default="stopwatch")  # stopwatch/manual
    manual_reason = models.CharField(max_length=255, blank=True)
    valid = models.BooleanField(default=True)
    invalid_reason = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["lap_no"]


# ---------------------------------------------------------------- issues
class IssueStatus(models.TextChoices):
    OPEN = "open", "Open"
    ASSIGNED = "assigned", "Assigned"
    IN_PROGRESS = "in_progress", "In Progress"
    PENDING_VERIFICATION = "pending_verification", "Pending Verification"
    CLOSED = "closed", "Closed"
    REOPENED = "reopened", "Reopened"


ISSUE_STATUS_TH = {
    "open": "เปิด", "assigned": "มอบหมายแล้ว", "in_progress": "กำลังแก้ไข",
    "pending_verification": "รอตรวจยืนยัน", "closed": "ปิดแล้ว", "reopened": "เปิดใหม่",
}

ISSUE_TRANSITIONS = {
    "open": {"assigned"},
    "reopened": {"assigned", "in_progress"},
    "assigned": {"in_progress", "assigned"},
    "in_progress": {"pending_verification"},
    "pending_verification": {"closed", "in_progress"},
    "closed": {"reopened"},
}


class IssueType(models.TextChoices):
    MAJOR = "major", "ความผิดปกติหลัก"
    MINOR = "minor", "ความผิดปกติรอง"
    IMPROVEMENT = "improvement", "โอกาสปรับปรุง (ตาราง 2)"
    UNDERSTANDING = "understanding", "ความเข้าใจ (ตาราง 3)"
    SUGGESTION = "suggestion", "ข้อเสนอแนะพนักงาน"
    REAL_EVENT = "real_event", "ความผิดปกติที่เกิดจริง (ตาราง 4)"
    OTHER = "other", "อื่น ๆ"


class Issue(models.Model):
    issue_no = models.CharField(max_length=40, unique=True)
    client_id = models.CharField(max_length=40, unique=True, null=True, blank=True)  # idempotent create
    audit = models.ForeignKey(Audit, null=True, blank=True, on_delete=models.PROTECT, related_name="issues")
    workshop = models.ForeignKey(Workshop, on_delete=models.PROTECT, related_name="issues")
    team = models.ForeignKey(Team, null=True, blank=True, on_delete=models.SET_NULL)
    station = models.CharField(max_length=80, blank=True)
    model = models.CharField(max_length=80, blank=True)
    employee = models.ForeignKey(Employee, null=True, blank=True, on_delete=models.SET_NULL)
    sheet = models.CharField("ระยะ/ตาราง", max_length=4, blank=True)  # s1..s4
    item_key = models.CharField(max_length=30, blank=True)
    item_code = models.CharField("รหัสข้อ", max_length=30, blank=True)
    issue_type = models.CharField(max_length=20, choices=IssueType.choices, default=IssueType.OTHER)
    priority = models.CharField("ความสำคัญ", max_length=10, blank=True)  # high/medium/low as chosen by auditor
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    owner = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="owned_pjo_issues")
    owner_name = models.CharField("ผู้รับผิดชอบ", max_length=160, blank=True)
    due_date = models.DateField(null=True, blank=True)
    containment = models.TextField("การแก้ไขทันที", blank=True)
    root_cause = models.TextField("สาเหตุ", blank=True)
    permanent_action = models.TextField("การแก้ไขถาวร", blank=True)
    effectiveness = models.TextField("ผลตรวจประสิทธิผล", blank=True)
    verifier = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    verified_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=24, choices=IssueStatus.choices, default=IssueStatus.OPEN)
    gbr = models.CharField("สถานะ G/B/R", max_length=1, blank=True)
    created_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    lock_version = models.PositiveIntegerField(default=1)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.issue_no

    @property
    def status_th(self):
        return ISSUE_STATUS_TH.get(self.status, self.status)

    @property
    def is_overdue(self):
        return bool(self.due_date and self.status != IssueStatus.CLOSED and self.due_date < timezone.localdate())

    @property
    def gbr_auto(self):
        """G/B/R as confirmed by the owner: G = Complete (closed), R = Overdue, B = On progress."""
        if self.status == IssueStatus.CLOSED:
            return "G"
        return "R" if self.is_overdue else "B"

    @property
    def is_repeat(self):
        return self.occurrences.count() > 1


class IssueOccurrence(models.Model):
    """Each time the same problem is found. Linking a new × to an existing issue
    adds a row here, so every finding keeps its own history."""

    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="occurrences")
    audit = models.ForeignKey(Audit, null=True, blank=True, on_delete=models.PROTECT, related_name="issue_occurrences")
    sheet = models.CharField(max_length=4, blank=True)
    item_key = models.CharField(max_length=30, blank=True)
    occurrence = models.PositiveSmallIntegerField(null=True, blank=True)
    origin_key = models.CharField(max_length=120, unique=True, null=True, blank=True)
    note = models.TextField(blank=True)
    mark_value_at_finding = models.CharField(max_length=5, blank=True)
    mark_changed_note = models.CharField(max_length=255, blank=True)
    found_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    found_at = models.DateTimeField(default=timezone.now)


class IssueEvent(models.Model):
    issue = models.ForeignKey(Issue, on_delete=models.CASCADE, related_name="events")
    from_status = models.CharField(max_length=24, blank=True)
    to_status = models.CharField(max_length=24, blank=True)
    action = models.CharField(max_length=40)
    comment = models.TextField(blank=True)
    user = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["at", "id"]


class MajorFollowUp(models.Model):
    """Response to a major abnormality as written in sheet 1 (stop, train offline,
    re-certify). The app records what people did; it never authorises restart."""

    class Stage(models.TextChoices):
        OPEN = "open", "รอดำเนินการ"
        TRAINED = "trained", "ฝึกอบรมแล้ว รอตรวจรับรองใหม่"
        RECERTIFIED = "recertified", "รับรองใหม่แล้ว"

    audit = models.ForeignKey(Audit, on_delete=models.CASCADE, related_name="major_followups")
    issue = models.OneToOneField(Issue, on_delete=models.CASCADE, related_name="major_followup")
    item_key = models.CharField(max_length=30)
    occurrence = models.PositiveSmallIntegerField()
    supervisor_notified = models.CharField("แจ้งหัวหน้า (ใคร/เวลา)", max_length=255, blank=True)
    immediate_action = models.TextField("การจัดการทันที", blank=True)
    training_by = models.CharField("ผู้ฝึกอบรม", max_length=160, blank=True)
    training_at = models.DateTimeField(null=True, blank=True)
    training_detail = models.TextField("เนื้อหาการฝึกอบรม", blank=True)
    recert_by = models.CharField("ผู้ตรวจรับรองใหม่", max_length=160, blank=True)
    recert_at = models.DateTimeField(null=True, blank=True)
    recert_result = models.TextField("ผลการสังเกตซ้ำ", blank=True)
    stage = models.CharField(max_length=12, choices=Stage.choices, default=Stage.OPEN)
    updated_at = models.DateTimeField(auto_now=True)


# ---------------------------------------------------------------- signatures
class SignatureRole(models.TextChoices):
    EMPLOYEE_MAJOR = "employee_major", "พนักงานยืนยันความผิดปกติหลัก"
    EMPLOYEE_MINOR = "employee_minor", "พนักงานยืนยันความผิดปกติรอง"
    EMPLOYEE_RECERT = "employee_recert", "ลายเซ็นยืนยันความผิดปกติหลักหลังการรับรองใหม่"
    RECERTIFIER = "recertifier", "ผู้รับรองใหม่"
    EMPLOYEE_S3 = "employee_s3", "ลายเซ็นของพนักงาน (ระยะที่ 2)"
    SUPERVISOR_S3 = "supervisor_s3", "ลายเซ็นของผู้บังคับบัญชา (Group Leader, MFG. Engineer, Process Eng.)"
    AUDITOR = "auditor", "ผู้ตรวจสอบ"


# which sheets a signature covers (locks)
SIGNATURE_SCOPE = {
    "employee_major": ["s1"],
    "employee_minor": ["s1"],
    "employee_recert": ["recert"],
    "recertifier": ["recert"],
    "employee_s3": ["s3"],
    "supervisor_s3": ["s3"],
    "auditor": ["header", "s1", "s2", "s3", "s4"],
}


class Signature(models.Model):
    audit = models.ForeignKey(Audit, on_delete=models.PROTECT, related_name="signatures")
    audit_revision = models.PositiveIntegerField()
    role = models.CharField(max_length=20, choices=SignatureRole.choices)
    followup = models.ForeignKey(MajorFollowUp, null=True, blank=True, on_delete=models.PROTECT, related_name="signatures")
    signer_user = models.ForeignKey(User, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    signer_name = models.CharField(max_length=160)
    signer_code = models.CharField(max_length=40, blank=True)
    identity_method = models.CharField(max_length=40)  # login / employee_code_witnessed
    witness = models.ForeignKey(User, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    statement = models.TextField()
    image_path = models.CharField(max_length=255)
    image_sha256 = models.CharField(max_length=64)
    data_hash = models.CharField(max_length=64)
    signed_at = models.DateTimeField(default=timezone.now)
    client_id = models.CharField(max_length=40, unique=True)
    superseded_at = models.DateTimeField(null=True, blank=True)
    superseded_reason = models.TextField(blank=True)

    class Meta:
        ordering = ["signed_at"]

    @property
    def role_th(self):
        return SignatureRole(self.role).label


class AuditRevision(models.Model):
    audit = models.ForeignKey(Audit, on_delete=models.CASCADE, related_name="revisions")
    revision = models.PositiveIntegerField()
    reason = models.TextField()
    affected = models.JSONField(default=list)
    data_before = models.JSONField()
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    created_at = models.DateTimeField(default=timezone.now)


# ---------------------------------------------------------------- files & trail
class Attachment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    audit = models.ForeignKey(Audit, null=True, blank=True, on_delete=models.CASCADE, related_name="attachments")
    issue = models.ForeignKey(Issue, null=True, blank=True, on_delete=models.CASCADE, related_name="attachments")
    purpose = models.CharField(max_length=30, default="evidence")  # evidence / fix_evidence
    path = models.CharField(max_length=255)
    original_name = models.CharField(max_length=255)
    content_type = models.CharField(max_length=100)
    size = models.PositiveIntegerField()
    note = models.CharField(max_length=255, blank=True)
    uploaded_by = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    uploaded_at = models.DateTimeField(auto_now_add=True)


class TrailEntry(models.Model):
    audit = models.ForeignKey(Audit, null=True, blank=True, on_delete=models.CASCADE, related_name="trail")
    issue = models.ForeignKey(Issue, null=True, blank=True, on_delete=models.CASCADE, related_name="trail")
    action = models.CharField(max_length=60)
    data = models.JSONField(default=dict)
    user = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="+")
    at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-at", "-id"]


class ProcessedOp(models.Model):
    """Idempotency for autosave / offline sync: an op id is applied once."""

    op_id = models.CharField(max_length=60, unique=True)
    audit = models.ForeignKey(Audit, null=True, on_delete=models.CASCADE)
    response = models.JSONField(default=dict)
    at = models.DateTimeField(auto_now_add=True)


class Counter(models.Model):
    name = models.CharField(max_length=40, unique=True)
    value = models.PositiveIntegerField(default=0)


def canonical_hash(data):
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True, default=str).encode("utf8")).hexdigest()
