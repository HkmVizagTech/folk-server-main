# Use the official Node.js 20 image.
FROM node:20-slim

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
COPY package*.json ./

# Install production dependencies.
RUN npm install --only=production

# Copy local code to the container image.
COPY . .

# Run the web service on container startup.
# We use the functions-framework to serve the ping function as the default entry point for health checks.
# Cloud Run automatically sets the PORT environment variable.
CMD [ "npm", "start" ]
