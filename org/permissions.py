"""Single source of truth for authorisation. Every view calls these helpers;
the UI only hides buttons, the server enforces."""
from django.core.exceptions import PermissionDenied

from .models import Role, RoleAssignment, Workshop


def roles_for(user, workshop=None):
    if not user.is_authenticated:
        return set()
    if user.is_superuser:
        return {r.value for r in Role}
    cache = getattr(user, "_pjo_role_cache", None)
    if cache is None:
        cache = list(RoleAssignment.objects.filter(user=user).values_list("role", "workshop_id"))
        user._pjo_role_cache = cache
    wid = workshop.id if isinstance(workshop, Workshop) else workshop
    # workshop=None asks "does the user hold this role anywhere?"
    return {role for role, w in cache if role == Role.ADMIN or wid is None or w is None or w == wid}


def is_admin(user):
    return user.is_superuser or Role.ADMIN in roles_for(user)


def has_role(user, workshop, *roles):
    r = roles_for(user, workshop)
    return Role.ADMIN in r or bool(r.intersection(roles))


def visible_workshops(user):
    if is_admin(user):
        return Workshop.objects.all()
    ids = set()
    all_scope = False
    for role, w in RoleAssignment.objects.filter(user=user).values_list("role", "workshop_id"):
        if w is None:
            all_scope = True
        else:
            ids.add(w)
    return Workshop.objects.all() if all_scope else Workshop.objects.filter(id__in=ids)


# ---- audit level -------------------------------------------------------
STAFF_ROLES = (Role.AUDITOR, Role.TLGL, Role.VIEWER, Role.VERIFIER, Role.ISSUE_OWNER)


def can_view_audit(user, audit):
    if has_role(user, audit.workshop_id, *STAFF_ROLES):
        return True
    emp = getattr(user, "employee", None)
    if emp is not None and audit.employee_id == emp.id:
        return True
    return audit.issues.filter(owner=user).exists()


def can_edit_audit(user, audit):
    return has_role(user, audit.workshop_id, Role.AUDITOR, Role.TLGL)


def can_create_audit(user, workshop):
    return has_role(user, workshop, Role.AUDITOR, Role.TLGL)


# ---- issue level -------------------------------------------------------
def can_view_issue(user, issue):
    return has_role(user, issue.workshop_id, *STAFF_ROLES) or issue.owner_id == user.id


def can_manage_issue(user, issue):
    """Assign, edit description, set due date."""
    return has_role(user, issue.workshop_id, Role.AUDITOR, Role.TLGL)


def can_work_issue(user, issue):
    """Record progress / submit for verification."""
    return issue.owner_id == user.id or can_manage_issue(user, issue)


def can_verify_issue(user, issue):
    return has_role(user, issue.workshop_id, Role.VERIFIER)


def require(cond):
    if not cond:
        raise PermissionDenied("ไม่มีสิทธิ์ดำเนินการนี้")
