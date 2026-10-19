FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV WEB_PORT=3000 API_URL=http://backend:3001
EXPOSE 3000
CMD ["node", "server.js"]
