# Imagen oficial de Playwright: trae Chromium y todas sus dependencias.
# La versión tiene que coincidir con la de `playwright` en package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# Herramientas de compilación para módulos nativos (better-sqlite3).
# Normalmente npm descarga un binario ya compilado; si para el Node de la
# imagen no existe (pasó al subir a Node 24), node-gyp lo compila aquí en
# vez de tumbar la build con "not found: make".
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

EXPOSE 3000
CMD ["node", "server.js"]
