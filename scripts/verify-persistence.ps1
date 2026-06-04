$ErrorActionPreference = 'Stop'

Set-Location "c:\Users\fernando.perezs\Desktop\proyectos\arena-app\arena-app"

Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
npm run build | Out-Null

$server = Start-Process -FilePath "node" -ArgumentList "dist/arena-app/server/server.mjs" -PassThru
Start-Sleep -Seconds 4

$base = 'http://localhost:4000'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = @{ identity = 'admin'; password = 'Hair-studio' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/api/auth/login" -WebSession $session -ContentType 'application/json' -Body $loginBody | Out-Null

$ts = Get-Date -Format 'yyyyMMddHHmmss'
$empEmail = "persist.final.$ts@arena.local"
$empUser = "persistfinal$ts"
$empBody = @{ email = $empEmail; username = $empUser; password = 'Empleado-123!'; role = 'client' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/api/admin/empleados" -WebSession $session -ContentType 'application/json' -Body $empBody | Out-Null

$clientEmail = "persist.final.client.$ts@cliente.local"
$clientBody = @{ fullName = 'Cliente Persistencia Final'; email = $clientEmail; phone = '600009999'; notes = 'test final' } | ConvertTo-Json
$clientRes = Invoke-RestMethod -Method Post -Uri "$base/api/admin/clientes" -WebSession $session -ContentType 'application/json' -Body $clientBody
$clientId = $clientRes.card.id

$treatBody = @{ name = 'Corte + peinado'; note = 'Persistencia tras reinicio' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$base/api/admin/clientes/$clientId/packs" -WebSession $session -ContentType 'application/json' -Body $treatBody | Out-Null

$cardsBefore = Invoke-RestMethod -Method Get -Uri "$base/api/admin/clientes" -WebSession $session
$cardBefore = $cardsBefore.cards | Where-Object { $_.id -eq $clientId } | Select-Object -First 1
$treatmentsBefore = @($cardBefore.treatments).Count

Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$server2 = Start-Process -FilePath "node" -ArgumentList "dist/arena-app/server/server.mjs" -PassThru
Start-Sleep -Seconds 4

$session2 = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Method Post -Uri "$base/api/auth/login" -WebSession $session2 -ContentType 'application/json' -Body $loginBody | Out-Null

$employeesAfter = Invoke-RestMethod -Method Get -Uri "$base/api/admin/empleados" -WebSession $session2
$empAfter = $employeesAfter.users | Where-Object { $_.email -eq $empEmail } | Select-Object -First 1

$cardsAfter = Invoke-RestMethod -Method Get -Uri "$base/api/admin/clientes" -WebSession $session2
$cardAfter = $cardsAfter.cards | Where-Object { $_.id -eq $clientId } | Select-Object -First 1

$treatmentsAfter = 0
if ($cardAfter) {
  $treatmentsAfter = @($cardAfter.treatments).Count
}

$result = [PSCustomObject]@{
  employeeEmail      = $empEmail
  employeePersisted  = [bool]$empAfter
  clientCardId       = $clientId
  clientCardPersisted = [bool]$cardAfter
  treatmentsBefore   = $treatmentsBefore
  treatmentsAfter    = $treatmentsAfter
}

$result | ConvertTo-Json -Depth 5

Stop-Process -Id $server2.Id -Force -ErrorAction SilentlyContinue
