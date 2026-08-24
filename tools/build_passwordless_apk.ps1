param(
    [string]$OutputName = "Zeekay-Power-v1.2.0-passwordless.apk"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$androidDir = Join-Path $repo "android"
$apiDir = Join-Path $repo "api"
$outputPath = Join-Path (Join-Path $repo "dist") $OutputName
$tokenBytes = New-Object byte[] 32
$token = $null

try {
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
    $encoded = [Convert]::ToBase64String($tokenBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    $token = "zk_" + $encoded

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))
    } finally {
        $sha.Dispose()
    }
    $tokenHash = ([BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    $keyId = [Guid]::NewGuid().ToString()

    $env:JAVA_HOME = "C:\Users\zeeka\.cache\zeekay-android-toolchain\jdk17\jdk-17.0.20.1+1"
    $env:ANDROID_HOME = "C:\Users\zeeka\.cache\zeekay-android-toolchain\android-sdk"
    $env:ZEEKAY_APP_TOKEN = $token

    & (Join-Path $androidDir "gradlew.bat") clean lintDebug assembleDebug --no-daemon -p $androidDir
    if ($LASTEXITCODE -ne 0) { throw "Android build failed" }

    $sql = "UPDATE api_keys SET revoked = 1 WHERE name = 'ZeeKay Power Android passwordless'; " +
        "INSERT INTO api_keys (id, name, key_hash, scope) VALUES ('$keyId', 'ZeeKay Power Android passwordless', '$tokenHash', 'full');"
    Push-Location $apiDir
    try {
        npm exec wrangler -- d1 execute zeekay-power-db --remote --command $sql
        if ($LASTEXITCODE -ne 0) { throw "Device-key registration failed" }
    } finally {
        Pop-Location
    }

    $headers = @{ Authorization = "Bearer $token"; Accept = "application/json" }
    $live = Invoke-RestMethod -Uri "https://power.zeekayeditz.com/api/status" -Headers $headers -Method Get
    if (-not $live.success) { throw "Passwordless API verification failed" }

    New-Item -ItemType Directory -Path (Split-Path -Parent $outputPath) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $androidDir "app\build\outputs\apk\debug\app-debug.apk") -Destination $outputPath -Force
    $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash
    $item = Get-Item -LiteralPath $outputPath

    [pscustomobject]@{
        passwordless_status_verified = $true
        device_key_scope = "full"
        output = $item.FullName
        bytes = $item.Length
        sha256 = $digest
    } | ConvertTo-Json
} finally {
    Remove-Item Env:ZEEKAY_APP_TOKEN -ErrorAction SilentlyContinue
    if ($tokenBytes) { [Array]::Clear($tokenBytes, 0, $tokenBytes.Length) }
    $token = $null
    $encoded = $null
    $tokenHash = $null
    $hashBytes = $null
}
