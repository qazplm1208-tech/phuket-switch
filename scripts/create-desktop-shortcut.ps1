[CmdletBinding()]
param([string]$DestinationDirectory = [Environment]::GetFolderPath('DesktopDirectory'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$destination = (Get-Item -LiteralPath $DestinationDirectory -ErrorAction Stop).FullName
$linkPath = Join-Path $destination 'Phuket Switch.lnk'
$ws = New-Object -ComObject WScript.Shell
$link = $ws.CreateShortcut($linkPath)
$link.TargetPath = Join-Path $root 'PhuketSwitch.bat'
$link.WorkingDirectory = $root
$link.IconLocation = "$(Join-Path $root 'electron\icon.ico'),0"
$link.WindowStyle = 7 # Minimized launcher; Electron controls its own window.
$link.Description = 'Phuket Switch'
$link.Save()
Write-Output $linkPath
