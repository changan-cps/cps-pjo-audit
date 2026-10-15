# Playwright base image ships Chromium + fonts so the server can render Thai PDFs.
FROM mcr.microsoft.com/playwright/python:v1.48.0-noble

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=config.settings \
    PRIVATE_MEDIA_ROOT=/data/private_media

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN python manage.py collectstatic --noinput \
    && useradd --create-home app && mkdir -p /data/private_media && chown -R app /data /app
USER app

EXPOSE 8000
CMD ["sh", "-c", "python manage.py migrate --noinput && python manage.py setup_pjo && gunicorn config.wsgi:application --bind 0.0.0.0:8000 --workers 3 --timeout 120"]
