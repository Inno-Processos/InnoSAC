FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV TZ=America/Sao_Paulo DATA_DIR=/data API_PORT=3001
VOLUME /data
EXPOSE 3001
CMD ["node", "src/index.js"]
