# Base de Node normal. Playwright instala su propio Chromium y las
# dependencias del sistema que necesite, según la versión exacta que
# haya en package.json. Así no hay dos versiones que mantener a la vez.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium

COPY . .

RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "server.js"]
