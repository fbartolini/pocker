# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app

# Update Alpine packages to fix CVE-2025-46394 and CVE-2024-58251 (busybox)
# This updates busybox from 1.37.0-r19 to 1.37.0-r20 or later
# Clear cache and update package index to ensure latest versions
RUN apk update && apk upgrade --no-cache && apk cache clean

# Update npm to latest version to fix CVE-2025-64756 (glob CLI vulnerability)
# This ensures npm's bundled glob package is patched
RUN npm install -g npm@latest

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run prepare && npm run build

FROM node:22-alpine AS runner
WORKDIR /app

# Update Alpine packages in runner stage to fix busybox vulnerabilities
# Clear cache and update package index to ensure latest versions
RUN apk update && apk upgrade --no-cache && apk cache clean

# Update npm to latest version to fix CVE-2025-64756 (glob CLI vulnerability)
RUN npm install -g npm@latest

ENV NODE_ENV=production \
	PORT=4173

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/build ./build

EXPOSE 4173
CMD ["node", "build/index.js"]

