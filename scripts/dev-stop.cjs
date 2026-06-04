const { execFileSync } = require('node:child_process');

const command = [
  'foreach ($p in 4000,4200) {',
  '  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |',
  '    Select-Object -ExpandProperty OwningProcess -Unique |',
  '    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }',
  '}',
  "Write-Host 'Puertos 4000/4200 liberados'",
].join('\n');

try {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { stdio: 'inherit' },
  );
} catch {
  // Si no hay procesos o PowerShell devuelve algo no crítico, no bloqueamos el flujo dev.
}

process.exit(0);
