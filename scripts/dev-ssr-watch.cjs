const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const target = resolve(__dirname, '..', 'dist', 'arena-app', 'server', 'server.mjs');
const waitIntervalMs = 1200;
const restartDelayMs = 1000;
let child = null;
let isShuttingDown = false;

const scheduleStart = () => {
  if (isShuttingDown) {
    return;
  }

  if (!existsSync(target)) {
    process.stdout.write('Esperando build SSR en dist/arena-app/server/server.mjs...\n');
    setTimeout(scheduleStart, waitIntervalMs);
    return;
  }

  child = spawn(process.execPath, ['--watch', target], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: '4000',
    },
  });

  child.on('exit', (code, signal) => {
    child = null;

    if (isShuttingDown) {
      process.exit(0);
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    process.stdout.write(`SSR watcher finalizó (${reason}). Reintentando...\n`);
    setTimeout(scheduleStart, restartDelayMs);
  });
};

const shutdown = () => {
  isShuttingDown = true;

  if (!child) {
    process.exit(0);
    return;
  }

  child.kill('SIGTERM');
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

scheduleStart();
