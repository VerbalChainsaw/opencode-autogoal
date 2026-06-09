# Goal State Reader (PowerShell fallback)
# Called by: SKILL.md via !`pwsh -File .opencode/skills/goal/scripts/read-state.ps1`
# Output: plain text goal summary to stdout

$statePath = ".opencode/.goal-state.json"

if (-not (Test-Path -LiteralPath $statePath)) {
    Write-Output "No active goal."
    exit 1
}

try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
} catch {
    Write-Output "No active goal."
    exit 1
}

if ($state.status -ne "active" -and $state.status -ne "paused") {
    Write-Output "No active goal."
    exit 1
}

$statusSuffix = if ($state.status -eq "paused") { " (PAUSED)" } else { "" }
$elapsed = [Math]::Round(((Get-Date).ToUniversalTime() - ([DateTimeOffset]::FromUnixTimeMilliseconds($state.startedAt))).TotalMinutes)
$maxTurns = if ($state.constraints.maxTurns) { $state.constraints.maxTurns } else { 20 }
$maxTime = if ($state.constraints.maxTimeMinutes) { $state.constraints.maxTimeMinutes } else { 30 }
$lastEval = if ($state.lastEvaluation.reason) { $state.lastEvaluation.reason } else { "none yet" }

Write-Output "Condition: $($state.condition)"
Write-Output "Status: $($state.status)$statusSuffix"
Write-Output "Progress: $($state.turnsEvaluated)/$maxTurns turns, $elapsed/$maxTime minutes"
Write-Output "Last evaluation: $lastEval"

if ($state.constraints.maxTurns) {
    Write-Output "Constraint: Stop after $($state.constraints.maxTurns) turns."
}
if ($state.constraints.maxTimeMinutes) {
    Write-Output "Constraint: Stop after $($state.constraints.maxTimeMinutes) minutes."
}
if ($state.command) {
    Write-Output "Verification: ``$($state.command)``"
}

exit 0
