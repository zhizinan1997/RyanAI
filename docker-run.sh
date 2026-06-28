#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Build and run the RyanAI Docker container locally.
# ---------------------------------------------------------------------------

readonly IMAGE="ryanai"
readonly CONTAINER="ryanai"
readonly HOST_PORT="${OPEN_WEBUI_PORT:-3000}"
readonly CONTAINER_PORT=8080

echo "Building ${IMAGE} image..."
docker build --build-arg USE_SLIM=true -t "$IMAGE" .

echo "Stopping any existing ${CONTAINER} container..."
docker stop "$CONTAINER" 2>/dev/null || true
docker rm "$CONTAINER" 2>/dev/null || true

echo "Starting ${CONTAINER}..."
docker run -d \
  -p "${HOST_PORT}:${CONTAINER_PORT}" \
  --add-host=host.docker.internal:host-gateway \
  -e RYANAI_DISABLE_LOCAL_EMBEDDING_MODELS=true \
  -e RAG_EMBEDDING_ENGINE="${RAG_EMBEDDING_ENGINE:-openai}" \
  -e RAG_EMBEDDING_MODEL="${RAG_EMBEDDING_MODEL:-text-embedding-3-small}" \
  -e RAG_EMBEDDING_MODEL_AUTO_UPDATE=false \
  -e RAG_OPENAI_API_BASE_URL="${RAG_OPENAI_API_BASE_URL:-}" \
  -e RAG_OPENAI_API_KEY="${RAG_OPENAI_API_KEY:-}" \
  -v "${IMAGE}:/app/backend/data" \
  --name "$CONTAINER" \
  --restart always \
  "$IMAGE"

echo "Cleaning up dangling images..."
docker image prune -f

echo "RyanAI is running at http://localhost:${HOST_PORT}"
