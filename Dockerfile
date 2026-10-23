FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8088
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node server.mjs responses.mjs sglang-responses.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node config ./config
COPY --chown=node:node public ./public
COPY --chown=node:node docs ./docs
USER node
EXPOSE 8088
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8088/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
