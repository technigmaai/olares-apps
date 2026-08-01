FROM node:24-bookworm-slim

# Install runtime dependencies needed by pi agent
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep curl python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Install pi coding agent globally
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# The base image already has 'node' user with uid/gid 1000
# Ensure /workspace exists and is owned by uid 1000
RUN mkdir -p /workspace && chown 1000:1000 /workspace

USER 1000
WORKDIR /workspace

ENTRYPOINT ["pi"]
