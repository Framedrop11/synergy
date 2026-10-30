# Use official lightweight Node.js 20 LTS runtime
FROM node:20-slim

# Set working directory inside container
WORKDIR /usr/src/app

# Set production environment
ENV NODE_ENV=production
ENV PORT=5001

# Copy dependency manifests first for optimal Docker layer caching
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Run as non-root node user for security
USER node

# Expose backend port
EXPOSE 5001

# Healthcheck to monitor container status
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 5001) + '/health', (r) => { if (r.statusCode !== 200) process.exit(1); }).on('error', () => process.exit(1))"

# Start the Express server
CMD ["npm", "start"]
