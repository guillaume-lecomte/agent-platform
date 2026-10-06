# Build context: repository root (see docker-compose.yml).
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@agent-platform/api...
# Keep only production dependencies of the API, with workspace packages copied in.
RUN pnpm --filter=@agent-platform/api --prod deploy --legacy /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
# Pricing and routing policy, read at startup (CONFIG_DIR defaults to ./config).
COPY --from=build /repo/config ./config
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
