# ClaudeCodeUI Dockerfile
# Multi-stage build for React/Vite frontend + Express backend

# Stage 1: Build
FROM node:20-alpine AS builder

# Install build dependencies for native modules (bcrypt, better-sqlite3, node-pty)
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source files
COPY . .

# Build frontend
RUN npm run build

# Stage 2: Production
FROM node:20-alpine

# Install runtime dependencies for native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built frontend from builder
COPY --from=builder /app/dist ./dist

# Copy server code
COPY --from=builder /app/server ./server

# Copy shared utilities
COPY --from=builder /app/shared ./shared

# Copy public assets
COPY --from=builder /app/public ./public

# Create database directory
RUN mkdir -p /app/server/database

# Environment
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "server/index.js"]
