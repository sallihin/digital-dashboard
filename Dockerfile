FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json server.js ./
COPY public ./public

# Data lives in a volume mounted here; make it writable by the non-root user.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 3000
CMD ["node", "server.js"]
