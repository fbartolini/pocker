# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run prepare && npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
	PORT=4173

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/build ./build

EXPOSE 4173
CMD ["node", "build/index.js"]

