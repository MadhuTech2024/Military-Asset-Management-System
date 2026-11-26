$ErrorActionPreference = "Stop"

if ($env:NODE_ENV -eq "production") {
  throw "The local demo seed cannot run when NODE_ENV is production."
}

$secret = Read-Host "Enter the agreed temporary demo password" -AsSecureString
if ($secret.Length -lt 12 -or $secret.Length -gt 72) {
  $secret.Dispose()
  throw "The password must meet the existing 12-72 character limit."
}

$environmentNames = @(
  "ENABLE_LOCAL_DEMO_SEED",
  "LOCAL_DEMO_SEED_PASSWORD"
)
$previousValues = @{}
foreach ($name in $environmentNames) {
  $previousValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

$passwordPointer = [IntPtr]::Zero
$plainPassword = $null
$locationChanged = $false
try {
  $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $env:ENABLE_LOCAL_DEMO_SEED = "true"
  $env:LOCAL_DEMO_SEED_PASSWORD = $plainPassword
  Push-Location (Split-Path -Parent $PSScriptRoot)
  $locationChanged = $true
  npm run seed:demo
  if ($LASTEXITCODE -ne 0) {
    throw "The local demo seed failed. Review its safe error message."
  }
}
finally {
  if ($locationChanged) {
    Pop-Location
  }
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
  $secret.Dispose()
  $plainPassword = $null
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousValues[$name], "Process")
  }
}
