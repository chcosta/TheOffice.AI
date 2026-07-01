# install-prerequisites.ps1
# Installs the external tools TheOffice.AI needs that are NOT bundled with the app.
#
# Bundled with the app (no install needed): portable Node, the Copilot CLI + SDK
# (vendored in node_modules), and a vendored ripgrep used by Copilot.
#
# Prerequisites installed here (via winget, per-user scope, no admin required):
#   - Git            (Git.Git)              required — every repo / PR / worktree flow
#   - Azure CLI      (Microsoft.AzureCLI)   required for Azure DevOps (az account get-access-token / az login)
#   - ripgrep        (BurntSushi.ripgrep.MSVC) recommended — server code-search endpoint spawns `rg`
#
# WebView2 (the renderer) is provisioned automatically by the Tauri installer.
#
# One-time user actions AFTER install (interactive, not done here):
#   - copilot            # sign in to GitHub Copilot
#   - az login           # sign in to Azure (for Azure DevOps access)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-prerequisites.ps1
#   powershell -ExecutionPolicy Bypass -File install-prerequisites.ps1 -Quiet

param(
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

function Write-Info($msg) { if (-not $Quiet) { Write-Host $msg } }

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

$winget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $winget) {
    Write-Warning "winget (App Installer) not found. Install it from the Microsoft Store, then re-run this script."
    Write-Warning "Manual alternatives: Git https://git-scm.com/download/win  |  Azure CLI https://aka.ms/installazurecliwindows  |  ripgrep https://github.com/BurntSushi/ripgrep/releases"
    exit 1
}

# name, winget id, command to probe, required?
$prereqs = @(
    @{ Name = 'Git';        Id = 'Git.Git';                 Probe = 'git'; Required = $true  },
    @{ Name = 'Azure CLI';  Id = 'Microsoft.AzureCLI';      Probe = 'az';  Required = $true  },
    @{ Name = 'ripgrep';    Id = 'BurntSushi.ripgrep.MSVC'; Probe = 'rg';  Required = $false }
)

$failed = @()

foreach ($p in $prereqs) {
    if (Test-Command $p.Probe) {
        Write-Info "[ok]      $($p.Name) already installed."
        continue
    }
    Write-Info "[install] $($p.Name) ($($p.Id)) ..."
    $args = @('install', '--id', $p.Id, '-e', '--source', 'winget',
              '--accept-package-agreements', '--accept-source-agreements',
              '--scope', 'user')
    if ($Quiet) { $args += @('--silent', '--disable-interactivity') }
    & winget @args
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "  $($p.Name) install returned exit code $LASTEXITCODE."
        if ($p.Required) { $failed += $p.Name }
    }
}

Write-Info ""
Write-Info "Prerequisite check complete."
Write-Info "Next (one-time, interactive): run 'copilot' to sign in to GitHub Copilot, and 'az login' for Azure DevOps."

if ($failed.Count -gt 0) {
    Write-Warning ("These REQUIRED prerequisites did not install cleanly: " + ($failed -join ', ') + ". Please install them manually and restart the app.")
    exit 1
}
exit 0
