#!/usr/bin/env pwsh
# Build and package IOPaint for PyPI release.
#
# Usage:
#   pwsh ./publish.ps1             # build wheel + sdist into ./dist
#   pwsh ./publish.ps1 -Upload     # build, then upload to PyPI via twine
#   pwsh ./publish.ps1 -Test       # build, then upload to TestPyPI
#   pwsh ./publish.ps1 -Help
#
# Requires:
#   - PowerShell 7+ (pwsh) recommended for cross-platform compatibility
#   - uv  (https://docs.astral.sh/uv/getting-started/installation/)
#   - nodejs/npm
#
# Note on encoding: This script deliberately uses ASCII-only markers (>>, [OK],
# [X]) instead of Unicode glyphs like "▶" or "✓", so it renders correctly on
# Windows PowerShell 5.1 with the default cp936 (GB2312) console code page
# without requiring `chcp 65001` or any manual console reconfiguration.

[CmdletBinding()]
param(
    [switch]$Upload,
    [switch]$Test,
    [switch]$Install,
    [switch]$Reinstall,
    [switch]$Help
)

# ---------------------------------------------------------------------------
# Hard fail on errors / undefined variables
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Console encoding — make stdout/stderr UTF-8 so twine/uv output looks right
# (does NOT change the visible glyphs, only the byte stream PowerShell emits)
# ---------------------------------------------------------------------------
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # Older hosts may not allow this — ignore.
}

# ---------------------------------------------------------------------------
# Helpers (ASCII-only, no fancy unicode so cp936 terminals display cleanly)
# ---------------------------------------------------------------------------
function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host ">> $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host ""
    Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host ""
    Write-Host "[!] $Message" -ForegroundColor Yellow
}

function Write-ErrorAndExit {
    param([string]$Message)
    Write-Host ""
    Write-Host "[X] $Message" -ForegroundColor Red
    exit 1
}

function Show-Help {
    $help = @"
publish.ps1 - Build and package IOPaint for PyPI release.

Usage:
  pwsh ./publish.ps1                # build wheel + sdist into ./dist
  pwsh ./publish.ps1 -Install       # build, then pip-install the wheel locally
  pwsh ./publish.ps1 -Install -Reinstall  # force-reinstall, overwrite existing
  pwsh ./publish.ps1 -Upload        # build, then upload to PyPI via twine
  pwsh ./publish.ps1 -Test          # build, then upload to TestPyPI
  pwsh ./publish.ps1 -Help

Mutually exclusive: -Upload, -Test, -Install

Requires: uv, nodejs/npm
"@
    Write-Host $help
    exit 0
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
if ($Help) { Show-Help }
if ($Upload -and $Test) {
    Write-ErrorAndExit "Cannot use -Upload and -Test at the same time."
}
if ($Upload -and $Install) {
    Write-ErrorAndExit "Cannot use -Upload and -Install at the same time."
}
if ($Test -and $Install) {
    Write-ErrorAndExit "Cannot use -Test and -Install at the same time."
}

$UploadTarget = $null
if     ($Upload)  { $UploadTarget = 'pypi' }
elseif ($Test)    { $UploadTarget = 'testpypi' }
elseif ($Install) { $UploadTarget = '__install__' }   # sentinel for local install

# ---------------------------------------------------------------------------
# 0. Resolve project root
# ---------------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $ScriptDir | Out-Null
try {
    Write-Host "Project root: $(Get-Location)" -ForegroundColor DarkGray

    # -----------------------------------------------------------------------
    # 1. Locate uv on PATH
    # -----------------------------------------------------------------------
    Write-Step "1/6 Locating uv on PATH"
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uv) {
        # Fallback: probe common install locations (uv installer drops it in
        # %LOCALAPPDATA%\Microsoft\WindowsApps or %USERPROFILE%\.local\bin).
        $candidates = @(
            "$env:USERPROFILE\.local\bin\uv.exe",
            "$env:USERPROFILE\.cargo\bin\uv.exe",
            "$env:LOCALAPPDATA\Microsoft\WindowsApps\uv.exe",
            "C:\Program Files\uv\uv.exe"
        )
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate) {
                $uvDir = Split-Path -Parent $candidate
                $env:Path = "$uvDir;$env:Path"
                Write-Host "  * Found uv at $candidate" -ForegroundColor DarkGray
                $uv = Get-Command uv -ErrorAction SilentlyContinue
                break
            }
        }
    }

    if (-not $uv) {
        Write-ErrorAndExit "'uv' is required but not found on PATH. Install: https://docs.astral.sh/uv/getting-started/installation/"
    }
    Write-Host "  * Using uv: $($uv.Source)" -ForegroundColor DarkGray

    # -----------------------------------------------------------------------
    # 2. Sync Python deps (incl. dev group: wheel, twine)
    # -----------------------------------------------------------------------
    Write-Step "2/6 Sync Python deps (incl. dev group: wheel, twine)"
    & uv sync --group dev
    if ($LASTEXITCODE -ne 0) { Write-ErrorAndExit "uv sync failed (exit $LASTEXITCODE)." }

    # -----------------------------------------------------------------------
    # 3. Build frontend (web_app/dist)
    # -----------------------------------------------------------------------
    Write-Step "3/6 Build frontend (web_app/dist)"
    Push-Location (Join-Path $PWD 'web_app') | Out-Null
    try {
        if (Test-Path -LiteralPath 'dist') {
            Remove-Item -LiteralPath 'dist' -Recurse -Force
        }
        & npm run build
        if ($LASTEXITCODE -ne 0) { Write-ErrorAndExit "npm run build failed (exit $LASTEXITCODE)." }
    } finally {
        Pop-Location | Out-Null
    }

    # -----------------------------------------------------------------------
    # 4. Copy frontend dist into Python package
    # -----------------------------------------------------------------------
    Write-Step "4/6 Copy frontend dist into Python package"
    $pkgWebApp = Join-Path $PWD 'iopaint\web_app'
    if (Test-Path -LiteralPath $pkgWebApp) {
        Remove-Item -LiteralPath $pkgWebApp -Recurse -Force
    }
    Copy-Item -Path (Join-Path $PWD 'web_app\dist') -Destination $pkgWebApp -Recurse -Force

    # -----------------------------------------------------------------------
    # 5. Clean previous build artifacts
    # -----------------------------------------------------------------------
    Write-Step "5/6 Clean previous build artifacts"
    foreach ($name in @('dist', 'build', 'iopaint.egg-info')) {
        $path = Join-Path $PWD $name
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }

    # -----------------------------------------------------------------------
    # 6. Build wheel + sdist via uv (PEP 517)
    # -----------------------------------------------------------------------
    Write-Step "6/6 Build wheel + sdist via uv (PEP 517)"
    & uv build
    if ($LASTEXITCODE -ne 0) { Write-ErrorAndExit "uv build failed (exit $LASTEXITCODE)." }

    # Show artifacts
    Write-Step "Artifacts:"
    Get-ChildItem -Path (Join-Path $PWD 'dist') -File |
        ForEach-Object {
            $sizeKb = [math]::Round($_.Length / 1KB, 1)
            "{0,12}  {1}" -f "$sizeKb KB", $_.Name
        } | Write-Host

    # ---------------------------------------------------------------------------
    # Optional: upload via twine
    # ---------------------------------------------------------------------------
    if ($UploadTarget) {
        if ($UploadTarget -eq '__install__') {
            # ---------- Local install into current uv environment ----------
            Write-Step "Installing built wheel locally into the uv environment"
            $wheels = Get-ChildItem -Path (Join-Path $PWD 'dist') -Filter '*.whl' -File
            if (-not $wheels) {
                Write-ErrorAndExit "No wheel artifact found under .\dist. Build step may have failed."
            }
            $wheelPath = $wheels[0].FullName
            $reinstallFlag = @()
            if ($Reinstall) { $reinstallFlag = '--reinstall' }
            & uv pip install @reinstallFlag $wheelPath
            if ($LASTEXITCODE -ne 0) { Write-ErrorAndExit "uv pip install failed (exit $LASTEXITCODE)." }
            Write-Success "Local install complete: $wheelPath"
            Write-Host ""
            Write-Host "Verify with:  uv run iopaint --help" -ForegroundColor Yellow
        } else {
            # ---------- Upload to PyPI / TestPyPI ----------
            Write-Step "Uploading to $UploadTarget"
            $artifacts = Get-ChildItem -Path (Join-Path $PWD 'dist') -File | Select-Object -ExpandProperty FullName
            & uv run --group dev twine upload --skip-existing $artifacts --repository $UploadTarget
            if ($LASTEXITCODE -ne 0) { Write-ErrorAndExit "twine upload failed (exit $LASTEXITCODE)." }
            Write-Success "Upload complete ($UploadTarget)"
        }
    } else {
        Write-Host ""
        Write-Warn "Next:"
        Write-Host "    uv run --group dev twine upload dist/*                          # upload to PyPI"
        Write-Host "    uv run --group dev twine upload --repository testpypi dist/*    # dry-run via TestPyPI"
    }

    Write-Success "publish.ps1 finished"
}
finally {
    Pop-Location | Out-Null
}