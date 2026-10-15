import json

from django.contrib.auth import get_user_model
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST

from org import permissions as perm
from org.models import Role

from . import services as S
from .models import Audit, Issue, IssueOccurrence, IssueStatus, MajorFollowUp, PJOTemplate


def _json(request):
    try:
        return json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return {}


def api(view):
    """Wrap API views: login, JSON errors for rule/permission failures."""

    @login_required
    def inner(request, *a, **kw):
        try:
            return view(request, *a, **kw)
        except S.RuleError as e:
            return JsonResponse({"ok": False, "code": e.code, "message": str(e), **e.extra}, status=409 if e.code == "conflict" else 400)
        except PermissionDenied as e:
            return JsonResponse({"ok": False, "code": "forbidden", "message": str(e) or "ไม่มีสิทธิ์"}, status=403)

    inner.__name__ = view.__name__
    return inner


def _audit_for(request, pk, edit=False):
    a = get_object_or_404(Audit.objects.select_related("workshop", "template"), pk=pk)
    perm.require(perm.can_view_audit(request.user, a))
    if edit:
        perm.require(perm.can_edit_audit(request.user, a))
    return a


def _issue_brief(i):
    return {"id": i.id, "issue_no": i.issue_no, "title": i.title, "status": i.status, "status_th": i.status_th,
            "item_code": i.item_code, "station": i.station, "owner": i.owner_name or (i.owner.get_full_name() if i.owner else ""),
            "due_date": i.due_date.isoformat() if i.due_date else None, "overdue": i.is_overdue, "type": i.issue_type,
            "fix": i.permanent_action or i.containment, "gbr": i.gbr_auto}


def audit_state(a, user):
    marks = {}
    for m in a.marks.select_related("recorded_by"):
        marks[f"{m.item_key}|{m.occurrence}"] = {"v": m.value, "by": m.recorded_by.get_full_name() or m.recorded_by.username,
                                                 "at": timezone.localtime(m.recorded_at).strftime("%d/%m/%Y %H:%M")}
    occ = {}
    for o in IssueOccurrence.objects.filter(audit=a).select_related("issue"):
        occ[f"{o.item_key}|{o.occurrence or 0}"] = _issue_brief(o.issue) | {"origin": o.origin_key}
    s3 = {x.item_key: {"employee_answer": x.employee_answer, "before": x.before, "coaching": x.coaching, "after": x.after,
                       "by": x.evaluator.get_full_name() if x.evaluator else "",
                       "at": timezone.localtime(x.evaluated_at).strftime("%d/%m/%Y %H:%M") if x.evaluated_at else ""}
          for x in a.s3_answers.select_related("evaluator")}
    sugg = [{"client_id": s.client_id, "description": s.description, "suggestion": s.suggestion, "owner_name": s.owner_name,
             "issue": _issue_brief(s.issue) if s.issue else None} for s in a.suggestions.order_by("id")]
    s4 = [{"client_id": r.client_id, "case_key": r.case_key, "case_text": r.case_text, "is_real_event": r.is_real_event,
           "employee_answer": r.employee_answer, "coaching": r.coaching, "result": r.result, "improvement": r.improvement,
           "issue": _issue_brief(r.issue) if r.issue else None} for r in a.s4_reviews.order_by("id")]
    timing = [S.timing_summary(t) for t in a.timings.filter(saved=True, discarded=False).prefetch_related("laps")]
    followups = [{
        "id": f.id, "item_key": f.item_key, "occurrence": f.occurrence, "stage": f.stage, "stage_th": f.get_stage_display(),
        "issue": _issue_brief(f.issue), "supervisor_notified": f.supervisor_notified, "immediate_action": f.immediate_action,
        "training_by": f.training_by, "training_at": f.training_at.isoformat() if f.training_at else "",
        "training_detail": f.training_detail, "recert_by": f.recert_by,
        "recert_at": f.recert_at.isoformat() if f.recert_at else "", "recert_result": f.recert_result,
        "signatures": [_sig_row(r) for r in S.recert_signatures(f)],
    } for f in a.major_followups.select_related("issue")]
    sigs = [_sig_row(r) for r in S.required_signatures(a)]
    open_issues = a.issues.exclude(status=IssueStatus.CLOSED).count()
    return {
        "id": a.id, "audit_no": a.audit_no, "status": a.status, "status_th": a.status_th, "revision": a.revision,
        "lock_version": a.lock_version, "locked": sorted(S.locked_sheets(a)),
        "can_edit": perm.can_edit_audit(user, a), "marks": marks, "findings": occ, "s3": s3, "suggestions": sugg,
        "s4": s4, "timing": timing, "followups": followups, "signatures": sigs, "open_issues": open_issues,
        "recert_pending": sum(1 for f in followups if f["stage"] != "recertified"),
        "header": {f: (str(getattr(a, f)) if getattr(a, f) is not None else "") for f in S.HEADER_FIELDS},
        "server_now": timezone.now().timestamp() * 1000,
    }


def _sig_row(r):
    s = r["signature"]
    return {"role": r["role"], "label": r["label"], "required": r.get("required", True), "statement": r["statement"],
            "signed": bool(s), "signer": s.signer_name if s else "", "method": s.identity_method if s else "",
            "at": timezone.localtime(s.signed_at).strftime("%d/%m/%Y %H:%M") if s else "", "sig_id": s.id if s else None}


@api
@require_GET
def state(request, pk):
    a = _audit_for(request, pk)
    return JsonResponse({"ok": True, "state": audit_state(a, request.user)})


@api
@require_POST
def ops(request, pk):
    a = _audit_for(request, pk, edit=True)
    body = _json(request)
    results = S.apply_ops(a, request.user, body.get("ops", []))
    return JsonResponse({"ok": True, "results": results, "lock_version": a.lock_version, "status": a.status,
                         "saved_at": timezone.localtime().strftime("%H:%M:%S")})


@api
@require_POST
def finding(request, pk):
    """Create (or link) an issue for a × / understanding gap / real event."""
    a = _audit_for(request, pk, edit=True)
    b = _json(request)
    sheet = b.get("sheet")
    if sheet not in ("s1", "s2", "s3", "s4"):
        raise S.RuleError("ระบุตารางไม่ถูกต้อง")
    if sheet in ("s1", "s2", "s3"):
        S.ensure_editable(a, sheet)
    link = None
    if b.get("link_issue_id"):
        link = get_object_or_404(Issue, pk=b["link_issue_id"])
        perm.require(perm.can_view_issue(request.user, link))
    owner = None
    if b.get("owner_id"):
        owner = get_user_model().objects.filter(pk=b["owner_id"]).first()
    title = (b.get("title") or "").strip()
    if not title and not link:
        raise S.RuleError("กรุณาระบุรายละเอียดปัญหา")
    origin = None
    if sheet == "s4":
        origin = f"A{a.id}:S4:{b.get('review_id')}"
    elif sheet == "s3" and b.get("suggestion_id"):
        origin = f"A{a.id}:SUG:{b.get('suggestion_id')}"
    elif sheet == "s2" and b.get("row_id"):
        origin = f"A{a.id}:S2ROW:{b.get('row_id')}"
    with transaction.atomic():
        issue, created = S.record_finding(
            a, request.user, sheet=sheet, item_key=b.get("item_key", ""), occurrence=b.get("occurrence"),
            title=title or link.title, description=b.get("description", ""), priority=b.get("priority", ""),
            owner=owner, owner_name=b.get("owner_name", ""), due_date=b.get("due_date") or None,
            link_issue=link, client_id=b.get("client_id"), origin=origin,
        )
        if sheet == "s4" and b.get("review_id"):
            a.s4_reviews.filter(client_id=b["review_id"]).update(issue=issue, is_real_event=True)
        if sheet == "s3" and b.get("suggestion_id"):
            a.suggestions.filter(client_id=b["suggestion_id"]).update(issue=issue)
        if b.get("containment"):
            issue.containment = b["containment"]
            issue.save(update_fields=["containment"])
    return JsonResponse({"ok": True, "created": created, "issue": _issue_brief(issue),
                         "major_followup": getattr(getattr(issue, "major_followup", None), "id", None)})


@api
@require_GET
def link_candidates(request, pk):
    """Open issues of the same workshop, same station/item first, for 'same problem' linking."""
    a = _audit_for(request, pk)
    item = request.GET.get("item_key", "")
    from django.db.models import Q
    qs = Issue.objects.filter(workshop=a.workshop)
    q = request.GET.get("q", "").strip()
    if q:
        qs = qs.filter(Q(title__icontains=q) | Q(issue_no__icontains=q) | Q(description__icontains=q))
    qs = qs.order_by("-id")[:200]
    rows = sorted(qs, key=lambda i: (i.item_key != item, i.station != a.station, i.status == "closed", -i.id))[:25]
    return JsonResponse({"ok": True, "issues": [_issue_brief(i) for i in rows]})


@api
@require_POST
def timing(request, pk):
    a = _audit_for(request, pk, edit=True)
    s = S.save_timing(a, request.user, _json(request))
    return JsonResponse({"ok": True, "session": S.timing_summary(s), "saved": s.saved})


@api
@require_POST
def submit(request, pk):
    a = _audit_for(request, pk, edit=True)
    S.submit_for_signatures(a, request.user)
    return JsonResponse({"ok": True, "state": audit_state(a, request.user)})


@api
@require_POST
def sign(request, pk):
    a = _audit_for(request, pk)
    b = _json(request)
    role = b.get("role")
    method = b.get("identity_method")
    followup = None
    if b.get("followup_id"):
        followup = get_object_or_404(MajorFollowUp, pk=b["followup_id"], audit=a)
    # who may record which signature
    if method == "login":
        if role in ("employee_major", "employee_minor", "employee_s3", "employee_recert"):
            emp = getattr(request.user, "employee", None)
            perm.require(emp is not None and emp.id == a.employee_id)
        elif role == "auditor":
            perm.require(a.auditor_id == request.user.id or perm.has_role(request.user, a.workshop_id, Role.AUDITOR))
        else:
            perm.require(perm.has_role(request.user, a.workshop_id, Role.TLGL, Role.AUDITOR, Role.VERIFIER))
    else:
        # employee without an account signs on the auditor's device; the auditor is the witness
        perm.require(perm.can_edit_audit(request.user, a))
    S.sign(a, request.user, role=role, data_url=b.get("image", ""), client_id=b.get("client_id") or "",
           signer_name=(b.get("signer_name") or "").strip(), signer_code=(b.get("signer_code") or "").strip(),
           identity_method=method, followup=followup, strokes=b.get("strokes", 0))
    a.refresh_from_db()
    return JsonResponse({"ok": True, "state": audit_state(a, request.user)})


@api
@require_POST
def amend(request, pk):
    a = _audit_for(request, pk, edit=True)
    b = _json(request)
    S.amend(a, request.user, b.get("reason", ""), b.get("sheets", []))
    a.refresh_from_db()
    return JsonResponse({"ok": True, "state": audit_state(a, request.user)})


@api
@require_POST
def cancel(request, pk):
    a = _audit_for(request, pk, edit=True)
    S.cancel_audit(a, request.user, _json(request).get("reason", ""))
    return JsonResponse({"ok": True})


@api
@require_POST
def change_template(request, pk):
    a = _audit_for(request, pk, edit=True)
    t = get_object_or_404(PJOTemplate, pk=_json(request).get("template_id"), status="published")
    perm.require(perm.can_create_audit(request.user, t.workshop))
    S.change_template(request.user, a, t)
    return JsonResponse({"ok": True})


@api
@require_POST
def upload(request, pk):
    a = _audit_for(request, pk, edit=True)
    issue = None
    if request.POST.get("issue_id"):
        issue = get_object_or_404(Issue, pk=request.POST["issue_id"], workshop=a.workshop)
    out = []
    for f in request.FILES.getlist("files"):
        att = S.save_attachment(request.user, f, audit=a, issue=issue, note=request.POST.get("note", ""))
        out.append({"id": str(att.id), "name": att.original_name})
    return JsonResponse({"ok": True, "files": out})
