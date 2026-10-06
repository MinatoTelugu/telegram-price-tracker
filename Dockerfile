FROM node:20-slim

WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY package*.json ./
RUN npm ci --omit=dev

# App code
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
