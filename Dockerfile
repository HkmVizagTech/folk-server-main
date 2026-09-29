# Use the official Node.js 20 image.
FROM node:20-slim

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
COPY package*.json ./

# Install production dependencies.
RUN npm install --omit=dev

# Copy local code to the container image.
COPY . .

# Run the web service on container startup.
# server.js serves every route, including /health for the platform health check.
# Cloud Run automatically sets the PORT environment variable.
CMD [ "npm", "start" ]
