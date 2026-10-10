# Official Node.js 20 image.
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /usr/src/app

# Install production dependencies first so this layer is cached between code changes.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy only what the server needs at runtime (see .dockerignore).
COPY src ./src

# Drop root privileges.
USER node

# Cloud Run / Railway set PORT. /health is the platform health-check path.
# Run node directly (not via npm) so SIGTERM reaches the graceful-shutdown handler.
CMD ["node", "src/server.js"]
