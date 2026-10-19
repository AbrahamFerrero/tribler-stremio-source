param(
  [Parameter(Mandatory = $true)][int]$BridgeProcessId,
  [ValidateRange(1, 300)][int]$DurationSeconds = 15,
  [ValidateRange(100, 2000)][int]$SampleIntervalMs = 250,
  [switch]$AlreadyResolvedTorrentPlayback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-LoopbackAddress([string]$Address) {
  $normalized = $Address.ToLowerInvariant()
  return $normalized -eq '::1' -or $normalized -match '^127\.' -or
    $normalized -match '^::ffff:127\.'
}

$target = Get-Process -Id $BridgeProcessId -ErrorAction Stop
if ($target.ProcessName -ne 'node') { throw 'BridgeProcessId must belong to node.exe' }
if (-not (Get-Command netstat -ErrorAction SilentlyContinue)) { throw 'netstat is unavailable' }

$samples = 0
$loopbackTcp = 0
$nonLoopbackTcp = 0
$udpBindings = 0
$deadline = (Get-Date).AddSeconds($DurationSeconds)
do {
  if (-not (Get-Process -Id $BridgeProcessId -ErrorAction SilentlyContinue)) {
    throw 'Bridge child exited during socket audit'
  }
  $tcpRows = @(& netstat -ano -p tcp)
  if ($LASTEXITCODE -ne 0) { throw 'netstat TCP sampling failed' }
  $udpRows = @(& netstat -ano -p udp)
  if ($LASTEXITCODE -ne 0) { throw 'netstat UDP sampling failed' }
  foreach ($row in $tcpRows) {
    $fields = @($row.Trim() -split '\s+')
    if ($fields.Count -lt 5 -or $fields[0] -ne 'TCP' -or $fields[-1] -ne "$BridgeProcessId") { continue }
    if ($fields[3] -in @('LISTENING', 'BOUND', 'TIME_WAIT')) { continue }
    $remoteAddress = $fields[2] -replace ':\d+$', '' -replace '^\[|\]$', ''
    if (Test-LoopbackAddress $remoteAddress) { $loopbackTcp++ }
    else { $nonLoopbackTcp++ }
  }
  foreach ($row in $udpRows) {
    $fields = @($row.Trim() -split '\s+')
    if ($fields.Count -ge 4 -and $fields[0] -eq 'UDP' -and $fields[-1] -eq "$BridgeProcessId") {
      $udpBindings++
    }
  }
  $samples++
  if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds $SampleIntervalMs }
} while ((Get-Date) -lt $deadline)

([ordered]@{
  phase = if ($AlreadyResolvedTorrentPlayback) { 'already-resolved-torrent-playback' } else { 'unconfirmed' }
  bridgePidKnown = $true
  auditDurationSeconds = $DurationSeconds
  samples = $samples
  loopbackTcpSamples = $loopbackTcp
  nonLoopbackTcpSamples = $nonLoopbackTcp
  loopbackTcpObserved = $loopbackTcp -gt 0
  nonLoopbackTcpObserved = $nonLoopbackTcp -gt 0
  externalTcpObserved = $nonLoopbackTcp -gt 0
  udpEndpointSamples = $udpBindings
  tcpResult = if (-not $AlreadyResolvedTorrentPlayback) { 'INCONCLUSIVE' }
    elseif ($nonLoopbackTcp -gt 0) { 'FAIL' }
    elseif ($loopbackTcp -eq 0) { 'INCONCLUSIVE' } else { 'PASS' }
  udpRemoteDestinationResult = 'NOT_TESTED'
  limitation = 'TCP is sampled, not packet capture; UDP endpoints do not reveal remote destinations.'
} | ConvertTo-Json -Compress)
