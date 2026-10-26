# CV Tree server for any Docker host (Fly.io, Railway, a VPS). Mount a volume at /data so the database survives restarts.
#   docker build -t cvtree-server server
#   docker run -p 8787:8787 -v cvtree-data:/data -e ADMIN_TOKEN=... -e OPENROUTER_API_KEY=... cvtree-server
FROM node:24-alpine
WORKDIR /app
COPY server.mjs db.mjs hosted-ai.mjs dashboard.html privacy.html ./
ENV PORT=8787 DB_PATH=/data/cvtree.db NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK CMD wget -qO- http://localhost:8787/health || exit 1
CMD ["node", "server.mjs"]
