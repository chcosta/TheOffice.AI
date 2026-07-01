# Stop a running TheOffice.AI instance so an in-place upgrade can overwrite locked
# files (notably node\node.exe, held open by the Node sidecar and any node.exe it
# spawned from the bundled runtime). Invoked by the NSIS PRE-install hook.
#
# Path-filtered: this ONLY stops node.exe whose image lives under the install
# directory, so unrelated Node processes on the machine — including the user's own
# dev servers — are never touched. Always exits 0; a failure here must not abort
# the upgrade (the installer's Retry/Ignore prompt remains as a last resort).

param(
  [string]$InstallDir = $env:THEOFFICE_INSTDIR
)

$ErrorActionPreference = 'SilentlyContinue'

function Stop-AppProcs {
  param([string]$dir)
  # The Tauri app window process.
  Get-Process 'TheOffice.AI' -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  if ([string]::IsNullOrWhiteSpace($dir)) { return }
  $norm = $dir.TrimEnd('\')
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($norm, [System.StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

try {
  for ($i = 0; $i -lt 20; $i++) {
    Stop-AppProcs -dir $InstallDir
    if ([string]::IsNullOrWhiteSpace($InstallDir)) { break }
    $node = Join-Path $InstallDir 'node\node.exe'
    if (-not (Test-Path $node)) { break }
    # Probe the lock: a running Windows image can't be opened for write. Success
    # means every process executing node.exe has exited and the file is free.
    try {
      $fs = [System.IO.File]::Open($node, 'Open', 'Write', 'None')
      $fs.Close()
      break
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
} catch {}

exit 0
