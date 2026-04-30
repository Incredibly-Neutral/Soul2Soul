# Use Node.js 18 Alpine for smaller image size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm install --only=production

# Copy the pre-built dist folder
COPY dist/ ./dist/

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S ccip -u 1001 -G nodejs

# Change ownership of app directory
RUN chown -R ccip:nodejs /app
USER ccip

# Expose port
EXPOSE 2002

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["npm", "start"]
