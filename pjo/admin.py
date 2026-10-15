from django.contrib import admin

from .models import Audit, Issue, PendingItem, PJOTemplate, Signature, SystemSetting, TrailEntry


@admin.register(PJOTemplate)
class TemplateAdmin(admin.ModelAdmin):
    list_display = ("workshop", "version", "status", "published_at")
    readonly_fields = ("content",)


@admin.register(Audit)
class AuditAdmin(admin.ModelAdmin):
    list_display = ("audit_no", "workshop", "audit_date", "status", "revision")
    readonly_fields = ("snapshot",)


@admin.register(Issue)
class IssueAdmin(admin.ModelAdmin):
    list_display = ("issue_no", "workshop", "title", "status", "due_date")


@admin.register(Signature)
class SignatureAdmin(admin.ModelAdmin):
    list_display = ("audit", "role", "signer_name", "signed_at", "superseded_at")

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(TrailEntry)
class TrailAdmin(admin.ModelAdmin):
    list_display = ("at", "user", "action", "audit", "issue")

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


admin.site.register(PendingItem)
admin.site.register(SystemSetting)
