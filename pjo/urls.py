from django.urls import path

from . import api, reports, views

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path("healthz/", views.healthz),
    path("plans/", views.plans, name="plans"),
    path("audits/start/", views.start, name="start"),
    path("audits/<int:pk>/", views.audit_form, name="audit_form"),
    path("issues/", views.issues, name="issues"),
    path("issues/<int:pk>/", views.issue_detail, name="issue_detail"),
    path("signatures/", views.pending_signatures, name="pending_signatures"),
    path("standards/", views.templates, name="templates"),
    path("standards/<int:pk>/", views.template_detail, name="template_detail"),
    path("standards/pending/<int:pk>/", views.pending_resolve, name="pending_resolve"),
    path("standards/gbr/", views.gbr_setting, name="gbr_setting"),
    path("reports/", reports.reports, name="reports"),
    path("reports/audits/<int:pk>/print/", reports.audit_print, name="audit_print"),
    path("reports/audits/<int:pk>/pdf/", reports.audit_pdf, name="audit_pdf"),
    path("reports/audits/<int:pk>/xlsx/", reports.audit_xlsx, name="audit_xlsx"),
    path("reports/issues.xlsx", reports.issues_xlsx, name="issues_xlsx"),
    path("files/attachment/<uuid:pk>/", views.attachment_file, name="attachment_file"),
    path("files/signature/<int:pk>/", views.signature_image, name="signature_image"),
    # JSON API for the audit form
    path("api/audits/<int:pk>/state/", api.state),
    path("api/audits/<int:pk>/ops/", api.ops),
    path("api/audits/<int:pk>/finding/", api.finding),
    path("api/audits/<int:pk>/link_candidates/", api.link_candidates),
    path("api/audits/<int:pk>/timing/", api.timing),
    path("api/audits/<int:pk>/submit/", api.submit),
    path("api/audits/<int:pk>/sign/", api.sign),
    path("api/audits/<int:pk>/amend/", api.amend),
    path("api/audits/<int:pk>/cancel/", api.cancel),
    path("api/audits/<int:pk>/change_template/", api.change_template),
    path("api/audits/<int:pk>/upload/", api.upload),
]
