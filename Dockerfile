FROM python:3.13-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml MANIFEST.in README.md LICENSE ./
COPY image_browser ./image_browser
RUN python -m pip install --no-cache-dir --root-user-action=ignore .

# Override with --user or Compose's user setting.
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["imgbrowse"]
CMD ["/media", "--host", "0.0.0.0", "--port", "8080"]
