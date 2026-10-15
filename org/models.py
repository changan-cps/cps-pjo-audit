"""Organisation: workshops, teams, employees and role assignments.

If this module is later merged into the existing CPS System, replace these
models with the CPS System's own Workshop/Team/User tables and keep
`org.permissions` as the single place that answers "may this user do X here?".
"""
from django.conf import settings
from django.db import models


class Workshop(models.Model):
    code = models.CharField(max_length=40, unique=True)  # e.g. GA, GA_Inspection
    name = models.CharField(max_length=120)
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["code"]

    def __str__(self):
        return self.name


class Team(models.Model):
    workshop = models.ForeignKey(Workshop, on_delete=models.PROTECT, related_name="teams")
    group = models.CharField("Group", max_length=80, blank=True)
    name = models.CharField("Team", max_length=80)
    line = models.CharField("Line", max_length=80, blank=True)
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["workshop__code", "group", "name"]
        unique_together = [("workshop", "group", "name")]

    def __str__(self):
        return f"{self.workshop.code} / {self.group + ' / ' if self.group else ''}{self.name}"


class Employee(models.Model):
    """A person who can be observed. Many operators do not have a login."""

    code = models.CharField("รหัสพนักงาน", max_length=40, unique=True)
    name = models.CharField("ชื่อ-สกุล", max_length=160)
    workshop = models.ForeignKey(Workshop, on_delete=models.PROTECT, related_name="employees")
    team = models.ForeignKey(Team, null=True, blank=True, on_delete=models.SET_NULL, related_name="employees")
    user = models.OneToOneField(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="employee")
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["code"]

    def __str__(self):
        return f"{self.code} {self.name}"


class Role(models.TextChoices):
    ADMIN = "admin", "Admin"
    AUDITOR = "auditor", "Auditor"
    TLGL = "tlgl", "TL/GL"
    EMPLOYEE = "employee", "Employee"
    ISSUE_OWNER = "issue_owner", "Issue Owner"
    VERIFIER = "verifier", "Verifier"
    VIEWER = "viewer", "Viewer"


class RoleAssignment(models.Model):
    """Role of a user, scoped to one workshop (or all workshops when workshop is empty)."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="pjo_roles")
    role = models.CharField(max_length=20, choices=Role.choices)
    workshop = models.ForeignKey(Workshop, null=True, blank=True, on_delete=models.CASCADE)

    class Meta:
        unique_together = [("user", "role", "workshop")]

    def __str__(self):
        return f"{self.user} {self.role} {self.workshop or 'ALL'}"
