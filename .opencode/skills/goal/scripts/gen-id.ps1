# ID Generator (PowerShell fallback)
# Called by: command.md via !`pwsh -File .opencode/skills/goal/scripts/gen-id.ps1`
# Output: JSON on stdout: { "id": "uuid", "timestamp": 1234567890 }

$id = [guid]::NewGuid().ToString()
$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

Write-Output "{`"id`": `"$id`", `"timestamp`": $timestamp}"
