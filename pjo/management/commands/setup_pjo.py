"""Load workshops, the 7 PJO templates, owner-confirmed corrections, settings and the
pending-confirmation list. Safe to run again: Published templates are never modified;
a changed source creates a new Draft, a confirmed correction creates a new Published version."""
import copy
import json
from pathlib import Path

from django.core.management.base import BaseCommand
from django.utils import timezone

from org.models import Workshop
from pjo.models import PendingItem, PJOTemplate, SystemSetting, canonical_hash

SEED = Path(__file__).resolve().parents[2] / "seed"


def apply_correction(content, corr):
    c = copy.deepcopy(content)
    for old, new in corr.get("replace_in_titles", []):
        for s in ("s1", "s2", "s3", "s4"):
            c[s]["title"] = c[s]["title"].replace(old, new)
    for q in c["s3"]["questions"]:
        if q["key"] in corr.get("set_s3_expected", {}):
            q["expected"] = corr["set_s3_expected"][q["key"]]
            q["expected_corrected_by"] = corr["code"]
    c.setdefault("corrections", []).append({"code": corr["code"], "note": corr["change_note"]})
    return c


class Command(BaseCommand):
    help = "Load PJO workshops, templates, confirmed corrections, settings and pending items"

    def handle(self, *args, **opts):
        for f in sorted((SEED / "templates").glob("*.json")):
            content = json.loads(f.read_text(encoding="utf8"))
            ws, _ = Workshop.objects.get_or_create(code=content["code"], defaults={"name": content["name"]})
            sha = canonical_hash(content)
            for t in PJOTemplate.objects.filter(workshop=ws, source_sha=""):  # rows created before source_sha existed
                if not t.content.get("corrections"):
                    t.source_sha = canonical_hash(t.content)
                    t.save(update_fields=["source_sha"])
            latest = PJOTemplate.objects.filter(workshop=ws).order_by("-version").first()
            if latest is None:
                PJOTemplate.objects.create(workshop=ws, version=1, status="published", content=content, source_sha=sha,
                                           source_file=content["source_file"], change_note="นำเข้าจากแบบฟอร์มต้นฉบับ",
                                           published_at=timezone.now())
                self.stdout.write(f"{ws.code}: template v1 published")
            elif not PJOTemplate.objects.filter(workshop=ws, source_sha=sha).exists():
                PJOTemplate.objects.create(workshop=ws, version=latest.version + 1, status="draft", content=content, source_sha=sha,
                                           source_file=content["source_file"], change_note="นำเข้าซ้ำจากไฟล์ต้นฉบับ (มีความต่าง) รอ Admin ตรวจและ Publish")
                self.stdout.write(f"{ws.code}: source changed -> new draft")

        # owner-confirmed corrections -> new Published version (old one Retired, old audits keep their snapshot)
        for corr in json.loads((SEED / "corrections.json").read_text(encoding="utf8")):
            ws = Workshop.objects.get(code=corr["workshop"])
            if any(x.get("code") == corr["code"] for t in PJOTemplate.objects.filter(workshop=ws) for x in t.content.get("corrections", [])):
                continue
            base = PJOTemplate.objects.filter(workshop=ws, status="published").order_by("-version").first()
            if base is None:
                continue
            v = PJOTemplate.objects.filter(workshop=ws).order_by("-version").first().version + 1
            PJOTemplate.objects.filter(pk=base.pk).update(status="retired", retired_at=timezone.now())
            PJOTemplate.objects.create(workshop=ws, version=v, status="published", content=apply_correction(base.content, corr),
                                       source_file=base.source_file, source_sha=base.source_sha, change_note=corr["change_note"],
                                       published_at=timezone.now())
            self.stdout.write(f"{ws.code}: correction {corr['code']} -> v{v} published")

        for s in json.loads((SEED / "settings.json").read_text(encoding="utf8")):
            SystemSetting.objects.get_or_create(key=s["key"], defaults={"value": s["value"]})

        for p in json.loads((SEED / "pending_items.json").read_text(encoding="utf8")):
            item, created = PendingItem.objects.get_or_create(code=p["code"], defaults={k: p[k] for k in ("title", "detail", "workshops", "sources")})
            if p.get("resolution") and item.status == "pending":
                item.status, item.resolution, item.resolved_at = "resolved", p["resolution"], timezone.now()
                item.save()
        self.stdout.write(self.style.SUCCESS("PJO setup done"))
