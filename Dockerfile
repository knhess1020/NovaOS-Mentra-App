# ---------- Base image ----------
FROM oven/bun:1.1

# ---------- App directory ----------
WORKDIR /app

# ---------- Copy package files ----------
COPY package.json ./
COPY bun.lock* ./

# ---------- Install dependencies ----------
RUN bun install --production

# ---------- Copy source ----------
COPY tsconfig.json ./
COPY src ./src

# ---------- Data directory for persistent storage ----------
RUN mkdir -p /app/data

# ---------- Railway expects PORT env ----------
ENV PORT=3000

# ---------- Start server ----------
CMD ["bun", "run", "start"]
