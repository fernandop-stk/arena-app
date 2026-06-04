$ErrorActionPreference = 'Stop'

Set-Location "c:\Users\fernando.perezs\Desktop\proyectos\arena-app\arena-app"

$ireneEmail = 'eneridelgado@gmail.com'
$newPassword = 'Qwertyu!'
$cardsPath = Join-Path (Get-Location) '.runtime-data\client-cards.json'

if (-not (Test-Path $cardsPath)) {
  throw "No existe el archivo de datos: $cardsPath"
}

$cards = Get-Content $cardsPath -Raw | ConvertFrom-Json

if (-not $cards) {
  $cards = @()
}

$hash = node -e "const { randomBytes, scryptSync } = require('crypto'); const password = process.argv[1]; const salt = randomBytes(16).toString('hex'); const derived = scryptSync(password, salt, 64).toString('hex'); process.stdout.write(salt + ':' + derived);" "$newPassword"

if (-not $hash) {
  throw 'No se pudo generar el hash de contraseña con Node.'
}

$ireneCard = $cards | Where-Object { $_.email -and $_.email.ToLower() -eq $ireneEmail } | Select-Object -First 1

if (-not $ireneCard) {
  $newId = "client-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-irene"
  $ireneCard = [pscustomobject]@{
    id            = $newId
    fullName      = 'Irene Delgado'
    email         = $ireneEmail
    phone         = '611 200 200'
    notes         = 'Cliente demo para visualización de historial.'
    createdAtIso  = (Get-Date).ToUniversalTime().ToString('o')
    createdByEmail = 'ferperezsanchez@gmail.com'
    treatments    = @()
    passwordHash  = $hash
  }
  $cards = @($cards) + @($ireneCard)
} else {
  $ireneCard.passwordHash = $hash
}

$json = $cards | ConvertTo-Json -Depth 20
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($cardsPath, $json, $utf8NoBom)

Write-Host "Contraseña de Irene actualizada en runtime-data."
Write-Host "Email: $ireneEmail"
Write-Host "Password: $newPassword"