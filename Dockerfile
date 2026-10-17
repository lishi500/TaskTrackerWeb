FROM node:22-alpine
WORKDIR /app
COPY . /app
EXPOSE 4173
# SECURITY: the Hub has no authentication. Binding 0.0.0.0 is only for use
# inside a container: publish the port to loopback only, for example
#   docker run -p 127.0.0.1:4173:4173 ...
# (the Host/Origin guards then accept http://localhost:4173 and http://127.0.0.1:4173).
ENV HOST=0.0.0.0
ENV PORT=4173
CMD ["node", "server.mjs"]
