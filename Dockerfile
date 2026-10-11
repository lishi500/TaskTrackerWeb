FROM node:22-alpine
WORKDIR /app
COPY . /app
EXPOSE 4173
ENV HOST=0.0.0.0
ENV PORT=4173
CMD ["node", "server.mjs"]
