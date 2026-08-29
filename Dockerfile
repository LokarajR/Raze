# Public webhook endpoint for real mode.
#
# Razorpay rejects localhost at save time, so the protected merchant has to be
# reachable on a public HTTPS host. This image runs the demo merchant in
# 'protected' mode — the Raze runtime in front of an unmodified handler.
#
# Requires DATABASE_URL. Raze's embedded Postgres is for local development; a
# deployed endpoint should point at a managed database.
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV MODE=protected
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "examples/demo-merchant/server.js"]
