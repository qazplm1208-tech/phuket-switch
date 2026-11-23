[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$logDir = Join-Path $root '.desktop'
$log = Join-Path $logDir 'setup.log'

function Invoke-Setup([string]$Command, [string[]]$Arguments) {
    $exe = (Get-Command $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $null = [IO.Directory]::CreateDirectory($logDir)
    # Windows PowerShell 5 surfaces redirected native stderr as a non-terminating error.
    $ErrorActionPreference = 'Continue'
    & $exe @Arguments >> $log 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$Command $($Arguments[0]) failed (exit $LASTEXITCODE).`nSee $log" }
}

Push-Location -LiteralPath $root
try {
    $needsBuild = -not ((Test-Path -LiteralPath 'dist/server/index.js' -PathType Leaf) -and
                        (Test-Path -LiteralPath 'dist/web/index.html' -PathType Leaf))
    if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
    if ($env:ELECTRON_MIRROR -eq 'https://npmmirror.com/mirrors/electron/' -and -not $env:ELECTRON_CUSTOM_DIR) {
        $env:ELECTRON_CUSTOM_DIR = '{{ version }}'
    }
    if (-not $env:electron_config_cache) { $env:electron_config_cache = Join-Path $root '.npm-cache\electron' }
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

    if ((-not (Test-Path -LiteralPath 'node_modules/electron/install.js')) -or
        (-not (Test-Path -LiteralPath 'node_modules/electron-updater/package.json')) -or
        (-not (Test-Path -LiteralPath 'node_modules/express/package.json')) -or
        ($needsBuild -and (-not (Test-Path -LiteralPath 'node_modules/.bin/vite.cmd') -or
                           -not (Test-Path -LiteralPath 'node_modules/.bin/tsc.cmd')))) {
        Invoke-Setup 'npm.cmd' @('install', '--include=dev', '--no-package-lock', '--no-fund', '--no-audit', '--cache', '.npm-cache')
    }
    if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
        # Electron 45 downloads its native binary separately from the npm package.
        Invoke-Setup 'node.exe' @('node_modules/electron/install.js')
    }
    if ($needsBuild) { Invoke-Setup 'npm.cmd' @('run', 'build') }

    # Launch the GUI executable directly: neither npm nor a console stays behind.
    Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $root
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Phuket Switch', 'OK', 'Error')
    exit 1
} finally { Pop-Location }
