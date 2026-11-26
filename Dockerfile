FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/monitor.db
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
