# Use the official Playwright Docker image as the base stage
FROM mcr.microsoft.com/playwright:v1.51.0-jammy AS base

# Install XVFB dependencies
RUN apt-get update && apt-get install -y \
  libx11-dev \
  libxcomposite-dev \
  libxdamage-dev \
  libxrandr-dev \
  x11-xserver-utils \
  xvfb \
  ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

#Install pnpm globally
RUN npm install -g pnpm

# Copy dependency files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY meet/package.json meet/pnpm-lock.yaml ./meet/

# Install dependencies
RUN pnpm install --filter "@bots/meet" --filter "bots"

# Install Playwright dependencies
RUN pnpm dlx playwright@1.51.0 install-deps

# Install Playwright browsers
RUN pnpm dlx playwright@1.51.0 install --with-deps

# Ensure the Playwright cache directory has the correct permissions
RUN mkdir -p /root/ms-playwright && chmod -R 777 /root/ms-playwright

# ======================================================
# Runtime stage
FROM mcr.microsoft.com/playwright:v1.51.0-jammy AS runtime

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
  pulseaudio \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm

# We need a non-root user to be able to start PulseAudio server
RUN useradd -m -u 1001 botuser
USER botuser

ARG DIRPATH=/home/botuser/app
WORKDIR $DIRPATH

# Copy what's needed from the base stage
COPY --from=base /app/node_modules $DIRPATH/node_modules
COPY --from=base /app/package.json $DIRPATH/package.json
COPY --from=base /app/pnpm-workspace.yaml $DIRPATH/pnpm-workspace.yaml
COPY --from=base /app/meet/node_modules $DIRPATH/meet/node_modules
COPY --from=base /app/meet/package.json $DIRPATH/meet/package.json
COPY --from=base /app/meet/pnpm-lock.yaml $DIRPATH/meet/pnpm-lock.yaml
COPY --from=base /root/ms-playwright /root/ms-playwright

# Copy files into the container
COPY src ./src
COPY meet/src ./meet/src
COPY meet/init.sh ./meet/init.sh

# Run Command
CMD ["sh", "-c", "./meet/init.sh"]
