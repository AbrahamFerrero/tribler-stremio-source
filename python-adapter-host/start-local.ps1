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
$startInfo.EnvironmentVariables.Clear()
foreach ($entry in Get-ChildItem Env:) {
    if ($entry.Name -in @('SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP') -or
        $entry.Name -match '^PYTHON_ADAPTER_[A-Z0-9_]+$') {
        $startInfo.EnvironmentVariables[$entry.Name.ToUpperInvariant()] = $entry.Value
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
    $startInfo.EnvironmentVariables[$name.ToUpperInvariant()] = $value
}

$startInfo.EnvironmentVariables['PYTHONUTF8'] = '1'
$startInfo.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
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
