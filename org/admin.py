from django.contrib import admin

from .models import Employee, RoleAssignment, Team, Workshop

admin.site.register(Workshop)
admin.site.register(Team)


@admin.register(Employee)
class EmployeeAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "workshop", "team", "user", "active")
    search_fields = ("code", "name")
    list_filter = ("workshop",)


@admin.register(RoleAssignment)
class RoleAssignmentAdmin(admin.ModelAdmin):
    list_display = ("user", "role", "workshop")
    list_filter = ("role", "workshop")
