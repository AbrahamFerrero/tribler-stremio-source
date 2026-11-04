$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $repositoryRoot ".env"

if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw "Missing local .env file at the repository root."
}

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = (Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$startInfo.Arguments = "-m adapter_host"
$startInfo.WorkingDirectory = $PSScriptRoot
$startInfo.UseShellExecute = $false
# EnvironmentVariables works on Windows PowerShell 5.1 and PowerShell 7.
# Clear the CHILD block before process creation; never modify Env: in the shell.
# .NET Framework can throw while lazily copying duplicate case-insensitive
# parent names. PowerShell can expose that first getter failure as null. The
# collection is already allocated; reacquire it, then clear it before use.
$childEnvironment = $null
try {
    $childEnvironment = $startInfo.EnvironmentVariables
} catch [System.ArgumentException] {
    $childEnvironment = $startInfo.EnvironmentVariables
}
if ($null -eq $childEnvironment) {
    $childEnvironment = $startInfo.EnvironmentVariables
}
if ($null -eq $childEnvironment) {
    throw "Unable to initialize isolated child environment."
}
$childEnvironment.Clear()
if ($childEnvironment.Count -ne 0) {
    throw "Unable to clear isolated child environment."
}
# The Env: provider also rejects duplicate case-insensitive names. Enumerate
# the process snapshot directly; filter before copying anything into the child.
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
    if ($entry.Key -in @('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP') -or
        $entry.Key -match '^PYTHON_ADAPTER_[A-Z0-9_]+$') {
        $normalizedName = $entry.Key.ToUpperInvariant()
        if ($childEnvironment.ContainsKey($normalizedName) -and
            $childEnvironment[$normalizedName] -cne $entry.Value) {
            throw "Conflicting allowed child environment entries."
        }
        $childEnvironment[$normalizedName] = $entry.Value
    }
}
foreach ($line in Get-Content -LiteralPath $environmentFile) {
    if ($line -notmatch '^\s*(PYTHON_ADAPTER_[A-Z0-9_]+)\s*=\s*(.*)\s*$') {
        continue
    }
    $name = $matches[1]
    $value = $matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    $childEnvironment[$name.ToUpperInvariant()] = $value
}

$childEnvironment['PYTHONUTF8'] = '1'
$childEnvironment['PYTHONIOENCODING'] = 'utf-8'
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $startInfo
$started = $false
try {
    if (-not $child.Start()) { throw "Python adapter process could not start." }
    $started = $true
    $child.WaitForExit()
    $childExitCode = $child.ExitCode
} finally {
    if ($started -and -not $child.HasExited) {
        $child.Kill()
        $child.WaitForExit()
    }
    $child.Dispose()
}
exit $childExitCode
