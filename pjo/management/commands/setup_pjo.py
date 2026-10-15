"""Load workshops, the 7 PJO templates (Published v1) and the pending-confirmation list.
Safe to run again: existing templates are never modified (a changed source creates a new Draft)."""
import json
from pathlib import Path

from django.core.management.base import BaseCommand
from django.utils import timezone

from org.models import Workshop
from pjo.models import PendingItem, PJOTemplate

SEED = Path(__file__).resolve().parents[2] / "seed"


class Command(BaseCommand):
    help = "Load PJO workshops, templates and pending items"

    def handle(self, *args, **opts):
        for f in sorted((SEED / "templates").glob("*.json")):
            content = json.loads(f.read_text(encoding="utf8"))
            ws, _ = Workshop.objects.get_or_create(code=content["code"], defaults={"name": content["name"]})
            latest = PJOTemplate.objects.filter(workshop=ws).order_by("-version").first()
            if latest is None:
                PJOTemplate.objects.create(workshop=ws, version=1, status="published", content=content,
                                           source_file=content["source_file"], change_note="นำเข้าจากแบบฟอร์มต้นฉบับ",
                                           published_at=timezone.now())
                self.stdout.write(f"{ws.code}: template v1 published")
            elif latest.content != content and not PJOTemplate.objects.filter(workshop=ws, content=content).exists():
                PJOTemplate.objects.create(workshop=ws, version=latest.version + 1, status="draft", content=content,
                                           source_file=content["source_file"], change_note="นำเข้าซ้ำจากไฟล์ต้นฉบับ (มีความต่าง)")
                self.stdout.write(f"{ws.code}: source changed -> new draft v{latest.version + 1}")
            else:
                self.stdout.write(f"{ws.code}: unchanged")
        for p in json.loads((SEED / "pending_items.json").read_text(encoding="utf8")):
            PendingItem.objects.get_or_create(code=p["code"], defaults={k: p[k] for k in ("title", "detail", "workshops", "sources")})
        self.stdout.write(self.style.SUCCESS("PJO setup done"))
