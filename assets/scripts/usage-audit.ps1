$ErrorActionPreference = "Stop"

# Install ccusage globally using the runtime already available on this computer.
$bun = Get-Command bun -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue

if ($bun) {
    Write-Host "Installing ccusage globally with Bun..."
    bun install -g ccusage
    $env:MYTOKEN_RUNTIME = "bun"
} elseif ($npm) {
    Write-Host "Installing ccusage globally with npm..."
    npm install -g ccusage
    $env:MYTOKEN_RUNTIME = "npm"
} else {
    throw "Bun or npm is required. Install Bun or Node.js with npm, then rerun this command."
}

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("mytoken-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workDir | Out-Null
$siteOrigin = if ($env:MYTOKEN_SITE_ORIGIN) { $env:MYTOKEN_SITE_ORIGIN.TrimEnd('/') } else { "https://mytoken.gay" }
$analyzerUrl = "$siteOrigin/scripts/usage-audit.mjs"
$analyzerPath = Join-Path $workDir "usage-audit.mjs"

try {
    Invoke-WebRequest -Uri $analyzerUrl -OutFile $analyzerPath
    if (Get-Command bun -ErrorAction SilentlyContinue) {
        bun run $analyzerPath
    } elseif (Get-Command node -ErrorAction SilentlyContinue) {
        node $analyzerPath
    } else {
        throw "No JavaScript runtime was found after installing ccusage."
    }
} finally {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
