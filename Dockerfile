FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY web/package.json web/package-lock.json ./
RUN npm ci --production=false

# Copy web source
COPY web/ ./

# Build (if needed for CLI usage)
# RUN npm run build

# Default: run the watcher
ENV SITEMGR_DEVICE_ID=docker
ENV SITEMGR_S3_REGION=us-east-1

ENTRYPOINT ["npx", "tsx"]
CMD ["bin/sitemgr.ts", "watch", "--once"]
