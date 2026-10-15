from org import permissions as perm


def nav(request):
    u = getattr(request, "user", None)
    if not u or not u.is_authenticated:
        return {}
    return {"nav_roles": sorted(perm.roles_for(u)), "nav_is_admin": perm.is_admin(u)}
