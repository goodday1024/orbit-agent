FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
EXPOSE 3000
CMD ["node","--use-env-proxy","server.mjs"]
