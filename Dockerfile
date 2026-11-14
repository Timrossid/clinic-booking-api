FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# build toolchain for better-sqlite3 if no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
