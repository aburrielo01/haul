# Imagen oficial de Playwright: trae Chromium y todas sus dependencias.
# IMPORTANTE: esta versión debe coincidir exactamente con la de "playwright"
# en package.json, que está fijada sin ^ justamente para eso.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev
# Red de seguridad: descarga el Chromium que corresponde a esta versión de
# Playwright aunque la imagen base se quedara corta.
RUN npx playwright install chromium

COPY . .

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

EXPOSE 3000
CMD ["node", "server.js"]
