param([switch]$OnlyIfIdle)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$electronPath = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronPath)) { throw 'Project Electron runtime not found.' }
$processes = @(Get-CimInstance Win32_Process)
$projectProcesses = @($processes | Where-Object { $_.ExecutablePath -eq $electronPath })
$rootIds = @($projectProcesses | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -ExpandProperty ProcessId)
foreach ($child in $projectProcesses) {
    $parent = $processes | Where-Object { $_.ProcessId -eq $child.ParentProcessId -and $_.Name -eq 'electron.exe' }
    if ($parent -and ($parent.ExecutablePath -eq $electronPath -or -not $parent.ExecutablePath)) {
        $rootIds += $parent.ProcessId
    }
}
$rootIds = @($rootIds | Select-Object -Unique)
if ($projectProcesses.Count -and -not $rootIds.Count) { throw 'Cannot safely identify the RecapTool main process.' }
if ($OnlyIfIdle) {
    $ownedIds = @($rootIds)
    do {
        $previousCount = $ownedIds.Count
        $children = @($processes | Where-Object { $ownedIds -contains $_.ParentProcessId } | Select-Object -ExpandProperty ProcessId)
        $ownedIds = @($ownedIds + $children | Select-Object -Unique)
    } while ($ownedIds.Count -gt $previousCount)
    $workers = @($processes | Where-Object { $ownedIds -contains $_.ProcessId -and $_.Name -notin @('electron.exe', 'crashpad_handler.exe') })
    if ($workers.Count) {
        Write-Output "Skipped restart: RecapTool still owns worker processes ($($workers.Name -join ', ')). Saved changes will load after the task finishes and the app restarts."
        return
    }
}
foreach ($id in $rootIds) {
    Stop-Process -Id $id -Force -ErrorAction Stop
}
Start-Sleep -Seconds 2
foreach ($child in $projectProcesses) {
    if (Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue) {
        Stop-Process -Id $child.ProcessId -Force -ErrorAction Stop
    }
}
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
$env:ELECTRON_RUN_AS_NODE = $null
$logDir = Join-Path $repoRoot '.tmp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$started = Start-Process -FilePath $electronPath -ArgumentList '.' -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'recap-startup.stdout.log') -RedirectStandardError (Join-Path $logDir 'recap-startup.stderr.log')
Start-Sleep -Seconds 5
$started.Refresh()
if ($started.HasExited) { throw 'RecapTool exited during startup; inspect .tmp startup logs.' }
Write-Output "RecapTool restarted from updated project. PID: $($started.Id)"
