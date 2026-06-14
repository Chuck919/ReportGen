FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-dejavu-core libfontconfig1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
ENV FREE_OCR_WORKERS=2 FREE_OCR_TIMEOUT_MS=1200000
EXPOSE 3000
CMD ["npm", "start"]