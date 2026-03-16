FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY engine/ ./engine/
COPY api/ ./api/

EXPOSE 3001

CMD ["node", "api/index.js"]
