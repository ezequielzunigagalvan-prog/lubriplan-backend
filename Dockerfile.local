# ─────────────────────────────────────────
# Stage 1: dependencias de producción
# ─────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev && \
    npx prisma generate

# ─────────────────────────────────────────
# Stage 2: imagen final
# ─────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Librerías nativas que bcrypt y pdfkit necesitan en Alpine
RUN apk add --no-cache \
    libc6-compat \
    fontconfig \
    freetype

# Copiamos solo lo necesario desde deps
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma

# Código fuente
COPY src ./src
COPY package.json ./

# Carpeta de uploads (imágenes locales cuando no hay Cloudinary)
RUN mkdir -p /app/uploads

EXPOSE 3001

CMD ["node", "src/index.js"]
