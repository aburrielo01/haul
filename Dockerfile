# Imagen oficial de Playwright: trae Chromium y todas sus dependencias.
FROM mcr.microsoft.com/playwright:v1.54.2-noble

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

EXPOSE 3000
CMD ["node", "server.js"]
