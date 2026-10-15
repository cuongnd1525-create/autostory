param(
    [string]$BasePython = 'C:\Users\p\AppData\Local\Programs\Python\Python311\python.exe',
    [switch]$Cuda
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $repoRoot '.venv-local'
$runtimePython = Join-Path $runtimeRoot 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) {
    & $BasePython -m venv $runtimeRoot
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create local Python runtime.' }
}
& $runtimePython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements-local.txt')
if ($LASTEXITCODE -ne 0) { throw 'Local runtime dependency installation failed.' }
if ($Cuda) {
    & $runtimePython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements-asr-cuda.txt')
    if ($LASTEXITCODE -ne 0) { throw 'CUDA runtime dependency installation failed.' }
}
& $runtimePython -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Local runtime has dependency conflicts.' }
& $runtimePython -c 'import numpy, soundfile, kokoro, faster_whisper, transformers, torch, sentencepiece, sacremoses; from transformers import AutoModelForSeq2SeqLM, AutoTokenizer; print("Local runtime imports OK")'
if ($LASTEXITCODE -ne 0) { throw 'Local runtime import validation failed.' }
Write-Output "Runtime ready: $runtimePython"
