# Cara a Cara — game server only.
#
# The image contains the code and nothing else: no cards, no scans. The cards
# are built on the host with ./setup.sh --no-serve and mounted at run time:
#
#   docker build -t cara-a-cara .
#   docker run -d --name cara-a-cara -p 127.0.0.1:8000:8000 \
#     -v "$PWD/data:/app/data:ro" -v "$PWD/state:/state" cara-a-cara
FROM python:3.12-slim
WORKDIR /app
COPY serve.py ./
COPY game/ ./game/
ENV CARA_STATE_DIR=/state CARA_DOCKER=1 PYTHONUNBUFFERED=1
VOLUME ["/app/data", "/state"]
EXPOSE 8000
# 0.0.0.0 is required inside the container; the -p mapping decides who can
# reach it. Keep 127.0.0.1 in -p unless the network is trusted.
CMD ["python", "serve.py", "--lan", "--port", "8000"]
