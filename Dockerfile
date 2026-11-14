# Harborline IVR. NOT TESTED: Docker was not installed where this was written. Read it before trusting it.
# Build:  docker build -t harborline-ivr .
# Run:    docker run -p 3000:3000 -v harborline-data:/app/data --env-file .env harborline-ivr
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# The practice database is a file: mount a volume here or it is lost on every deploy.
VOLUME /app/data
EXPOSE 3000
USER node
CMD ["node", "dist/src/server.js"]
