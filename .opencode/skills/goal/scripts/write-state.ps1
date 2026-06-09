# Goal State Writer (PowerShell fallback)
# Called by: command.md via !`pwsh -File .opencode/skills/goal/scripts/write-state.ps1 '<json>'`
# Uses atomic write (write-to-tmp-then-rename) to prevent corruption.
# Output: "OK" on success, "ERROR: ..." on failure

param([string]$jsonStr)

if (-not $jsonStr) {
    Write-Error "ERROR: No JSON state provided"
    exit 1
}

# Validate JSON
try {
    $state = $jsonStr | ConvertFrom-Json
} catch {
    Write-Error "ERROR: Invalid JSON: $_"
    exit 1
}

# Validate required fields
$required = @("version", "id", "condition", "status", "createdAt", "constraints")
foreach ($field in $required) {
    if (-not (Get-Member -InputObject $state -Name $field -MemberType Properties)) {
        Write-Error "ERROR: Missing required field '$field'"
        exit 1
    }
}

$statePath = ".opencode/.goal-state.json"
$tmpPath = "$statePath.tmp.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"

try {
    # Ensure .opencode directory exists
    $dir = Split-Path $statePath -Parent
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    # Atomic write: write to temp file, then rename
    $jsonStr | Out-File -FilePath $tmpPath -Encoding UTF8 -NoNewline
    # Add trailing newline
    Add-Content -Path $tmpPath -Value "" -Encoding UTF8
    Move-Item -LiteralPath $tmpPath -Destination $statePath -Force

    Write-Output "OK"
    exit 0
} catch {
    # Clean up temp file on failure
    Remove-Item -LiteralPath $tmpPath -ErrorAction SilentlyContinue
    Write-Error "ERROR: Failed to write state: $_"
    exit 1
}
