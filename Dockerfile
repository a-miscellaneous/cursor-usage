# Local Cursor usage monitor. keys.json is mounted at run time and is not part of the image.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs usage.mjs ./
COPY public ./public
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]
