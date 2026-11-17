$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$python = $null
foreach ($version in @('3.13', '3.12', '3.11', '3.10')) {
    & py "-$version" -c "import sys; print(sys.version)" *> $null
    if ($LASTEXITCODE -eq 0) {
        $python = $version
        break
    }
}
if (-not $python) {
    throw 'Python 3.10+ is required. Install Python and ensure the py launcher is available.'
}

$venv = Join-Path $root '.venv'
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    Write-Host "Creating Python $python virtual environment..."
    & py "-$python" -m venv $venv
}

$venvPython = Join-Path $venv 'Scripts\python.exe'
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install deepseek-harness-sdk
& $venvPython -c "import deepseek_harness; print('DeepSeek Harness SDK ready')"
Write-Host 'Python runtime is ready.'
