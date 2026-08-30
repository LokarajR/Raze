# The Raze Console, as a public webhook endpoint.
#
# Razorpay rejects localhost at save time, so anything that receives real
# deliveries has to be reachable on a public HTTPS host. This image runs the
# console: it is the endpoint you register in the Razorpay dashboard, it starts
# the merchant being audited as a child process, and it serves the page that
# shows what happened.
#
# git is installed because importing a merchant means cloning their repository
# at run time. Nothing from those repositories is ever committed here.
#
# Requires DATABASE_URL. The embedded Postgres is for local development; a
# deployed endpoint should point at a managed database.
FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "bin/raze", "web"]
