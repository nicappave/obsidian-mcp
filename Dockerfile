FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
# Mount your vault here: docker run -i --rm -v /path/to/vault:/vault obsidian-mcp
ENV OBSIDIAN_VAULT_PATH=/vault
ENTRYPOINT ["node", "dist/index.js"]
