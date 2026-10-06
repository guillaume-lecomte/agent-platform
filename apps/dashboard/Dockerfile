# Build context: repository root (see docker-compose.yml).
FROM node:26-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@agent-platform/dashboard

FROM nginx:1.27-alpine
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80
