# Axis MCP Server — Streamable HTTP モードで公開HTTPSにデプロイするためのイメージ
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# PORT はホスティング側が注入（Render/Railway 等）。未指定なら 8787。
EXPOSE 8787
CMD ["node", "dist/index.js"]
