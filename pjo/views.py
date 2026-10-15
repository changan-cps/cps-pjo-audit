import json
from datetime import date, timedelta
from pathlib import Path

from django.conf import settings
from django.contrib import messages
from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.db.models import Count, Q
from django.http import FileResponse, Http404, HttpResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_POST

from org import permissions as perm
from org.models import Employee, Role, Team, Workshop

from . import services as S
from .api import audit_state
from .models import (
    Attachment, Audit, AuditPlan, AuditStatus, Issue, IssueStatus, IssueType, ISSUE_STATUS_TH, MajorFollowUp,
    Mark, PendingItem, PJOTemplate, Signature, SystemSetting, TemplateStatus,
)

User = get_user_model()


def _ws_filter(request):
    wss = perm.visible_workshops(request.user)
    code = request.GET.get("workshop", "")
    sel = wss.filter(code=code).first() if code else None
    return wss, sel


# ------------------------------------------------------------------ dashboard
@login_required
def dashboard(request):
    wss, sel = _ws_filter(request)
    scope = [sel] if sel else list(wss)
    audits = Audit.objects.filter(workshop__in=scope).exclude(status=AuditStatus.CANCELLED)
    issues = Issue.objects.filter(workshop__in=scope)
    today = timezone.localdate()
    month_start = today.replace(day=1)
    plans = AuditPlan.objects.filter(workshop__in=scope, cancelled=False, planned_date__gte=month_start,
                                     planned_date__lt=(month_start + timedelta(days=32)).replace(day=1))
    plan_total = plans.count()
    plan_done = plans.filter(audits__status=AuditStatus.COMPLETED).distinct().count()
    fails = Mark.objects.filter(audit__in=audits, value="fail", item_key__startswith="S1-").select_related("audit")
    major = minor = 0
    by_item = {}
    for m in fails:
        it = m.audit.items().get(m.item_key, {})
        if it.get("severity") == "major":
            major += 1
        else:
            minor += 1
        k = (m.audit.workshop.code, m.item_key, it.get("text", "")[:90])
        by_item[k] = by_item.get(k, 0) + 1
    top_items = sorted(by_item.items(), key=lambda x: -x[1])[:8]
    open_qs = issues.exclude(status=IssueStatus.CLOSED)
    repeat = issues.annotate(n=Count("occurrences")).filter(n__gt=1)
    ctx = {
        "workshops": wss, "sel": sel, "today": today,
        "plan_total": plan_total, "plan_done": plan_done,
        "in_progress": audits.filter(status__in=[AuditStatus.DRAFT, AuditStatus.IN_PROGRESS]).count(),
        "pending_sig": audits.filter(status__in=[AuditStatus.PENDING_SIGNATURES, AuditStatus.AMENDED]).count(),
        "completed": audits.filter(status=AuditStatus.COMPLETED).count(),
        "completed_open": audits.filter(status=AuditStatus.COMPLETED, issues__status__in=[s for s in IssueStatus.values if s != "closed"]).distinct().count(),
        "major": major, "minor": minor, "top_items": top_items,
        "issues_open": open_qs.count(),
        "issues_overdue": open_qs.filter(due_date__lt=today).count(),
        "issues_verify": issues.filter(status=IssueStatus.PENDING_VERIFICATION).count(),
        "issues_repeat": repeat.count(),
        "fu_training": MajorFollowUp.objects.filter(audit__in=audits, stage=MajorFollowUp.Stage.OPEN).count(),
        "fu_recert": MajorFollowUp.objects.filter(audit__in=audits, stage=MajorFollowUp.Stage.TRAINED).count(),
        "recent": audits.select_related("workshop", "auditor")[:10],
        "overdue_list": open_qs.filter(due_date__lt=today).order_by("due_date")[:10],
    }
    return render(request, "pjo/dashboard.html", ctx)


# ------------------------------------------------------------------ plans & audit list
@login_required
def plans(request):
    wss, sel = _ws_filter(request)
    scope = [sel] if sel else list(wss)
    if request.method == "POST":
        ws = get_object_or_404(Workshop, pk=request.POST.get("workshop"))
        perm.require(perm.has_role(request.user, ws, Role.AUDITOR, Role.TLGL))
        if request.POST.get("action") == "cancel":
            p = get_object_or_404(AuditPlan, pk=request.POST.get("plan"), workshop=ws)
            p.cancelled = True
            p.save()
        else:
            AuditPlan.objects.create(
                workshop=ws, team=Team.objects.filter(pk=request.POST.get("team") or 0, workshop=ws).first(),
                station=request.POST.get("station", ""),
                employee=Employee.objects.filter(pk=request.POST.get("employee") or 0, workshop=ws).first(),
                planned_date=request.POST.get("planned_date") or timezone.localdate(),
                auditor=User.objects.filter(pk=request.POST.get("auditor") or 0).first(),
                note=request.POST.get("note", ""), created_by=request.user)
            messages.success(request, "เพิ่มแผนตรวจแล้ว")
        return redirect(request.get_full_path())
    status = request.GET.get("status", "")
    audits = Audit.objects.filter(workshop__in=scope).select_related("workshop", "auditor", "employee")
    if status:
        audits = audits.filter(status=status)
    q = request.GET.get("q", "").strip()
    if q:
        audits = audits.filter(Q(audit_no__icontains=q) | Q(station__icontains=q) | Q(employee_name__icontains=q))
    ctx = {
        "workshops": wss, "sel": sel,
        "plans": AuditPlan.objects.filter(workshop__in=scope, cancelled=False, planned_date__gte=timezone.localdate() - timedelta(days=31))
        .select_related("workshop", "team", "employee", "auditor").prefetch_related("audits"),
        "audits": audits[:300], "status": status, "q": q, "statuses": AuditStatus.choices,
        "teams": Team.objects.filter(workshop__in=scope), "employees": Employee.objects.filter(workshop__in=scope, active=True),
        "users": User.objects.filter(is_active=True).order_by("username"),
    }
    return render(request, "pjo/plans.html", ctx)


# ------------------------------------------------------------------ start audit
@login_required
def start(request):
    wss = [w for w in perm.visible_workshops(request.user) if perm.can_create_audit(request.user, w)]
    published = {t.workshop_id: t for t in PJOTemplate.objects.filter(status=TemplateStatus.PUBLISHED, workshop__in=wss).order_by("version")}
    plan = AuditPlan.objects.filter(pk=request.GET.get("plan") or request.POST.get("plan") or 0).first()
    if request.method == "POST":
        t = get_object_or_404(PJOTemplate, pk=request.POST.get("template"), status=TemplateStatus.PUBLISHED)
        perm.require(perm.can_create_audit(request.user, t.workshop))
        ws = t.workshop
        header = {k: request.POST.get(k, "").strip() for k in S.HEADER_FIELDS if k in request.POST}
        for k in ("standard_time_s", "takt_time_s"):
            header[k] = header.get(k) or None
        header["audit_date"] = request.POST.get("audit_date") or timezone.localdate()
        header["team"] = Team.objects.filter(pk=request.POST.get("team") or 0, workshop=ws).first()
        header["employee"] = Employee.objects.filter(pk=request.POST.get("employee") or 0, workshop=ws).first()
        header["tlgl_user"] = User.objects.filter(pk=request.POST.get("tlgl_user") or 0).first()
        if isinstance(header["audit_date"], str):
            header["audit_date"] = date.fromisoformat(header["audit_date"])
        a = S.create_audit(request.user, t, header, plan=plan if plan and plan.workshop_id == ws.id else None)
        return redirect("audit_form", pk=a.pk)
    ctx = {
        "workshops": [(w, published.get(w.id)) for w in wss], "plan": plan, "today": timezone.localdate(),
        "teams": Team.objects.filter(workshop__in=wss, active=True), "employees": Employee.objects.filter(workshop__in=wss, active=True),
        "users": User.objects.filter(is_active=True).order_by("username"),
    }
    return render(request, "pjo/start.html", ctx)


@login_required
def audit_form(request, pk):
    a = get_object_or_404(Audit.objects.select_related("workshop", "template", "auditor", "employee", "team"), pk=pk)
    perm.require(perm.can_view_audit(request.user, a))
    pending = PendingItem.objects.filter(status="pending")
    pending_ws = [p for p in pending if a.workshop.code in [w.strip() for w in p.workshops.split(",")]]
    pending_all = [p for p in pending if p.workshops == "ALL"]
    owners = User.objects.filter(is_active=True).order_by("username")
    ctx = {
        "a": a, "snap": a.snapshot,
        "boot": json.dumps({
            "snapshot": a.snapshot, "state": audit_state(a, request.user),
            "urls": {k: f"/api/audits/{a.pk}/{k}/" for k in ("state", "ops", "finding", "timing", "submit", "sign", "amend", "cancel", "upload", "link_candidates")},
            "user": {"id": request.user.id, "name": request.user.get_full_name() or request.user.username},
            "employee": {"id": a.employee_id, "code": a.employee.code if a.employee else "", "name": a.employee_name},
            "owners": [{"id": u.id, "name": u.get_full_name() or u.username} for u in owners],
            "gbr": S.gbr_mapping(),
            "meta": {"template_label": f"{a.template.label} ({a.template.get_status_display()})",
                     "auditor": a.auditor.get_full_name() or a.auditor.username, "team": str(a.team) if a.team else ""},
        }, ensure_ascii=False).replace("</", "<\\/"),
        "pending_ws": pending_ws, "pending_all": pending_all,
    }
    return render(request, "pjo/audit_form.html", ctx)


# ------------------------------------------------------------------ issues
@login_required
def issues(request):
    wss, sel = _ws_filter(request)
    scope = [sel] if sel else list(wss)
    qs = Issue.objects.filter(Q(workshop__in=scope) | Q(owner=request.user)).select_related("workshop", "team", "owner", "audit").distinct()
    f = {k: request.GET.get(k, "") for k in ("status", "team", "owner", "type", "due", "q", "overdue", "repeat", "mine")}
    if f["status"]:
        qs = qs.filter(status=f["status"])
    if f["team"]:
        qs = qs.filter(team_id=f["team"])
    if f["owner"]:
        qs = qs.filter(owner_id=f["owner"])
    if f["mine"]:
        qs = qs.filter(owner=request.user)
    if f["type"]:
        qs = qs.filter(issue_type=f["type"])
    if f["due"]:
        qs = qs.filter(due_date__lte=f["due"])
    if f["overdue"]:
        qs = qs.exclude(status=IssueStatus.CLOSED).filter(due_date__lt=timezone.localdate())
    if f["repeat"]:
        qs = qs.annotate(n=Count("occurrences")).filter(n__gt=1)
    if f["q"]:
        qs = qs.filter(Q(issue_no__icontains=f["q"]) | Q(title__icontains=f["q"]) | Q(station__icontains=f["q"]))
    ctx = {"workshops": wss, "sel": sel, "issues": qs[:500], "f": f, "statuses": IssueStatus.choices, "status_th": ISSUE_STATUS_TH,
           "types": IssueType.choices, "teams": Team.objects.filter(workshop__in=scope), "users": User.objects.filter(is_active=True)}
    return render(request, "pjo/issues.html", ctx)


@login_required
def issue_detail(request, pk):
    i = get_object_or_404(Issue.objects.select_related("workshop", "audit", "owner", "verifier"), pk=pk)
    perm.require(perm.can_view_issue(request.user, i))
    if request.method == "POST":
        act = request.POST.get("action")
        try:
            if int(request.POST.get("lock_version", i.lock_version)) != i.lock_version:
                raise S.RuleError("ปัญหานี้ถูกแก้ไขโดยผู้อื่นระหว่างนี้ กรุณาตรวจข้อมูลล่าสุดแล้วบันทึกอีกครั้ง")
            if act == "save":
                manage, work = perm.can_manage_issue(request.user, i), perm.can_work_issue(request.user, i)
                perm.require(manage or work)
                fields = ["containment", "root_cause", "permanent_action"]
                if manage:
                    fields += ["title", "description", "priority", "owner_name", "due_date"]
                if perm.can_verify_issue(request.user, i):
                    fields += ["effectiveness"]
                changed = {}
                for k in fields:
                    if k in request.POST:
                        v = request.POST.get(k) or ("" if k != "due_date" else None)
                        if str(getattr(i, k) or "") != str(v or ""):
                            changed[k] = v
                            setattr(i, k, v)
                if manage and "owner" in request.POST:
                    i.owner = User.objects.filter(pk=request.POST.get("owner") or 0).first()
                    if i.owner and not i.owner_name:
                        i.owner_name = i.owner.get_full_name() or i.owner.username
                gbr = request.POST.get("gbr")
                if gbr is not None and S.gbr_mapping():
                    i.gbr = gbr if gbr in ("G", "B", "R") else ""
                i.lock_version += 1
                i.save()
                i.events.create(action="updated", user=request.user, comment=", ".join(changed) or "บันทึก")
                for fobj in request.FILES.getlist("files"):
                    S.save_attachment(request.user, fobj, issue=i, purpose=request.POST.get("purpose", "fix_evidence"))
                messages.success(request, "บันทึกแล้ว")
            elif act == "transition":
                to = request.POST.get("to")
                if to in ("closed",) or (to == "in_progress" and i.status == "pending_verification"):
                    perm.require(perm.can_verify_issue(request.user, i))
                    if to == "closed" and request.POST.get("effectiveness"):
                        i.effectiveness = request.POST["effectiveness"]
                elif to in ("assigned", "reopened"):
                    perm.require(perm.can_manage_issue(request.user, i) or perm.can_verify_issue(request.user, i))
                else:
                    perm.require(perm.can_work_issue(request.user, i))
                S.transition_issue(i, request.user, to, request.POST.get("comment", ""))
                messages.success(request, f"เปลี่ยนสถานะเป็น {i.status_th}")
        except S.RuleError as e:
            messages.error(request, str(e))
        return redirect("issue_detail", pk=i.pk)
    ctx = {
        "i": i, "occurrences": i.occurrences.select_related("audit", "found_by"), "events": i.events.select_related("user"),
        "attachments": i.attachments.all(), "users": User.objects.filter(is_active=True).order_by("username"),
        "can_manage": perm.can_manage_issue(request.user, i), "can_work": perm.can_work_issue(request.user, i),
        "can_verify": perm.can_verify_issue(request.user, i), "gbr": S.gbr_mapping(),
        "followup": getattr(i, "major_followup", None),
    }
    return render(request, "pjo/issue_detail.html", ctx)


# ------------------------------------------------------------------ signatures
@login_required
def pending_signatures(request):
    wss = perm.visible_workshops(request.user)
    rows = []
    qs = Audit.objects.filter(Q(workshop__in=wss) | Q(employee__user=request.user)).filter(
        status__in=[AuditStatus.PENDING_SIGNATURES, AuditStatus.AMENDED]).select_related("workshop").distinct()
    for a in qs:
        missing = [r for r in S.required_signatures(a) if r["required"] and not r["signature"]]
        if missing:
            rows.append((a, missing))
    recert = []
    for f in MajorFollowUp.objects.filter(audit__workshop__in=wss).exclude(stage=MajorFollowUp.Stage.RECERTIFIED).select_related("audit", "issue"):
        recert.append(f)
    return render(request, "pjo/pending_signatures.html", {"rows": rows, "recert": recert})


# ------------------------------------------------------------------ templates admin
@login_required
def templates(request):
    perm.require(perm.is_admin(request.user) or perm.has_role(request.user, None, Role.AUDITOR, Role.TLGL, Role.VIEWER))
    wss = Workshop.objects.all()
    data = [(w, PJOTemplate.objects.filter(workshop=w).order_by("-version")) for w in wss]
    return render(request, "pjo/templates.html", {
        "data": data, "pending": PendingItem.objects.all(), "is_admin": perm.is_admin(request.user),
        "gbr": SystemSetting.get("gbr_mapping"),
    })


@login_required
def template_detail(request, pk):
    t = get_object_or_404(PJOTemplate, pk=pk)
    perm.require(perm.is_admin(request.user) or perm.has_role(request.user, t.workshop, Role.AUDITOR, Role.TLGL, Role.VIEWER))
    if request.method == "POST":
        perm.require(perm.is_admin(request.user))
        act = request.POST.get("action")
        try:
            if act == "new_draft":
                if PJOTemplate.objects.filter(workshop=t.workshop, status=TemplateStatus.DRAFT).exists():
                    raise S.RuleError("มี Draft ของ Workshop นี้อยู่แล้ว")
                v = PJOTemplate.objects.filter(workshop=t.workshop).order_by("-version").first().version + 1
                n = PJOTemplate.objects.create(workshop=t.workshop, version=v, content=t.content, source_file=t.source_file,
                                               change_note=f"คัดลอกจาก v{t.version}", created_by=request.user)
                return redirect("template_detail", pk=n.pk)
            if act == "edit_item":
                if t.status != TemplateStatus.DRAFT:
                    raise S.RuleError("แก้ไขได้เฉพาะ Draft")
                _edit_template_item(t, request.POST)
                messages.success(request, "บันทึกการแก้ไขแม่แบบแล้ว")
            elif act == "publish":
                if t.status != TemplateStatus.DRAFT:
                    raise S.RuleError("เผยแพร่ได้เฉพาะ Draft")
                note = request.POST.get("change_note", "").strip()
                if not note:
                    raise S.RuleError("ต้องระบุสิ่งที่เปลี่ยนแปลง")
                PJOTemplate.objects.filter(workshop=t.workshop, status=TemplateStatus.PUBLISHED).update(status=TemplateStatus.RETIRED, retired_at=timezone.now())
                t.status, t.published_at, t.published_by, t.change_note = TemplateStatus.PUBLISHED, timezone.now(), request.user, note
                t.save()
                messages.success(request, f"เผยแพร่ v{t.version} แล้ว Audit เดิมยังใช้มาตรฐานฉบับเดิม")
            elif act == "retire":
                t.status, t.retired_at = TemplateStatus.RETIRED, timezone.now()
                t.save()
            elif act == "delete_draft":
                if t.status != TemplateStatus.DRAFT or t.audits.exists():
                    raise S.RuleError("ลบได้เฉพาะ Draft ที่ยังไม่ถูกใช้")
                t.delete()
                return redirect("templates")
        except S.RuleError as e:
            messages.error(request, str(e))
        return redirect("template_detail", pk=t.pk)
    return render(request, "pjo/template_detail.html", {"t": t, "c": t.content, "is_admin": perm.is_admin(request.user)})


def _edit_template_item(t, post):
    c = t.content
    key = post.get("key")
    for i in c["s1"]["items"]:
        if i["key"] == key:
            i["text"] = post.get("text", i["text"])
            i["allow_na"] = post.get("allow_na") == "on"
            i.setdefault("edited", True)
    for s in c["s2"]["sections"]:
        for i in s["items"]:
            if i["key"] == key:
                i["text"] = post.get("text", i["text"])
    for q in c["s3"]["questions"]:
        if q["key"] == key:
            q["text"] = post.get("text", q["text"])
            q["expected"] = post.get("expected", q["expected"])
    for cs in c["s4"]["cases"]:
        if cs["key"] == key:
            cs["case"] = post.get("text", cs["case"])
            cs["answer"] = post.get("expected", cs["answer"])
    t.content = c
    t.save()


@login_required
@require_POST
def pending_resolve(request, pk):
    perm.require(perm.is_admin(request.user))
    p = get_object_or_404(PendingItem, pk=pk)
    p.resolution = request.POST.get("resolution", "").strip()
    if not p.resolution:
        messages.error(request, "ต้องระบุผลการยืนยัน")
    else:
        p.status, p.resolved_by, p.resolved_at = "resolved", request.user, timezone.now()
        p.save()
        messages.success(request, "บันทึกการยืนยันแล้ว")
    return redirect("templates")


@login_required
@require_POST
def gbr_setting(request):
    perm.require(perm.is_admin(request.user))
    vals = {k: request.POST.get(k, "").strip() for k in ("G", "B", "R")}
    if all(vals.values()):
        s, _ = SystemSetting.objects.get_or_create(key="gbr_mapping")
        s.value, s.updated_by = vals, request.user
        s.save()
        PendingItem.objects.filter(code="P02-GBR").update(status="resolved", resolution=json.dumps(vals, ensure_ascii=False),
                                                         resolved_by=request.user, resolved_at=timezone.now())
        messages.success(request, "บันทึกความหมาย G/B/R แล้ว")
    else:
        messages.error(request, "ต้องระบุความหมายครบทั้ง G, B, R")
    return redirect("templates")


# ------------------------------------------------------------------ private files
@login_required
def attachment_file(request, pk):
    att = get_object_or_404(Attachment, pk=pk)
    ok = (att.issue and perm.can_view_issue(request.user, att.issue)) or (att.audit and perm.can_view_audit(request.user, att.audit))
    perm.require(bool(ok))
    p = Path(settings.PRIVATE_MEDIA_ROOT) / att.path
    if not p.exists():
        raise Http404
    resp = FileResponse(open(p, "rb"), content_type=att.content_type)
    resp["Content-Disposition"] = f'inline; filename="{att.original_name}"'
    resp["Cache-Control"] = "private, no-store"
    return resp


@login_required
def signature_image(request, pk):
    s = get_object_or_404(Signature, pk=pk)
    perm.require(perm.can_view_audit(request.user, s.audit))
    p = Path(settings.PRIVATE_MEDIA_ROOT) / s.image_path
    if not p.exists():
        raise Http404
    resp = FileResponse(open(p, "rb"), content_type="image/png")
    resp["Cache-Control"] = "private, no-store"
    return resp


def healthz(request):
    return HttpResponse("ok")
