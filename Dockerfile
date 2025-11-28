# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app

# Update Alpine packages to fix CVE-2025-46394 and CVE-2024-58251 (busybox)
# This updates busybox from 1.37.0-r19 to the latest available version
RUN apk update && apk upgrade --no-cache

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run prepare && npm run build

FROM node:22-alpine AS runner
WORKDIR /app

# Update Alpine packages in runner stage to fix busybox vulnerabilities
RUN apk update && apk upgrade --no-cache

ENV NODE_ENV=production \
	PORT=4173

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/build ./build

EXPOSE 4173
CMD ["node", "build/index.js"]

