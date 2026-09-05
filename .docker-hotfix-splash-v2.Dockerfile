FROM ghcr.io/zhizinan1997/ryanai:v0.11.3.2-slim-splash-hotfix-20260904

COPY frontend-delta/ /app/build/

LABEL org.opencontainers.image.title="RyanAI splash notice hotfix" \
      org.opencontainers.image.version="v0.11.3.2-slim-splash-hotfix2-20260904" \
      io.ryanai.hotfix="splash-notice-authenticated-config-20260904"
