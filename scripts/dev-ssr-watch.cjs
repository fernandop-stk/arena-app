const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const target = resolve(__dirname, '..', 'dist', 'arena-app', 'server', 'server.mjs');
const waitIntervalMs = 1200;

const startServer = () => {
  const child = spawn(process.execPath, ['--watch', target], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: '4000',
    },
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
};

if (existsSync(target)) {
  startServer();
} else {
  process.stdout.write('Esperando build SSR en dist/arena-app/server/server.mjs...\n');

  const timer = setInterval(() => {
    if (!existsSync(target)) {
      return;
    }

    clearInterval(timer);
    startServer();
  }, waitIntervalMs);
}
