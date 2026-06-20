#Requires -Version 5.1
<#
.SYNOPSIS
  CandidateUsable=36 de-identification tool for Lobster/OpenClaw training records.

.DESCRIPTION
  Safety defaults:
  - DryRun is the default. Without -Run, this script does not read final_chat.txt.
  - DryRun only checks manifests, folder existence, and file existence.
  - -Run is required before reading final_chat.txt and writing de-identified output.
  - customer_info.txt is never read by this script.
  - Raw text is never printed to console, manifest, or privacy reports.

  This file is ASCII-safe for Windows PowerShell 5.1. Non-ASCII matching is done
  with Unicode char codes to avoid source encoding issues.
#>
[CmdletBinding()]
param(
  [switch] $DryRun,
  [switch] $Run,
  [int] $MaxLines = 0,
  [int] $MaxChars = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($DryRun -and $Run) {
  throw 'Use either -DryRun or -Run, not both.'
}

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataQualityPath = Join-Path $RepoRoot 'data_quality_manifest.csv'
$HermesManifestPath = Join-Path $RepoRoot 'hermes_training_pack_20260523_040314\hermes_training_manifest.csv'
$CandidateRoot = Join-Path $RepoRoot 'hermes_candidate_usable_data'
$TrainingOutputRoot = Join-Path $RepoRoot 'training_deidentified_output'

$Script:TokPhone = '[PHONE]'
$Script:TokPlate = '[PLATE]'
$Script:TokAddress = '[ADDRESS]'
$Script:TokId = '[ID]'
$Script:TokName = '[NAME]'
$Script:TokDriver = '[DRIVER]'
$Script:TokDispatchInfo = '[DISPATCH_INFO]'

function New-UString {
  param([int[]] $Codes)
  return (-join ($Codes | ForEach-Object { [char]$_ }))
}

$Script:AddressChars = @(
  0x5E02, # city
  0x7E23, # county
  0x5340, # district
  0x9109, # township
  0x939A, # town
  0x8DEF, # road
  0x8857, # street
  0x5DF7, # lane
  0x5F04, # alley
  0x865F, # number
  0x6A13, # floor
  0x6BB5  # section
) | ForEach-Object { [string]([char]$_) }

$Script:StrongAddressChars = @(
  0x5E02, # city
  0x7E23, # county
  0x5340, # district
  0x9109, # township
  0x939A, # town
  0x8DEF, # road
  0x8857, # street
  0x5DF7, # lane
  0x5F04, # alley
  0x865F, # number
  0x6BB5  # section
) | ForEach-Object { [string]([char]$_) }

$Script:ShortReplyAllowList = @(
  'OK',
  'ok',
  ([string]([char]0x597D)), # good/ok
  (-join @([char]0x597D, [char]0x7684)), # okay
  (-join @([char]0x6536, [char]0x5230)), # received
  (-join @([char]0x4E86, [char]0x89E3)), # understand
  (-join @([char]0x53D6, [char]0x6D88)), # cancel
  (-join @([char]0x53EF, [char]0x4EE5))  # can/ok
) | Select-Object -Unique

$Script:BehaviorSignalTerms = [ordered]@{
  CUSTOMER_CANCEL = @(
    (New-UString 0x4E0D, 0x7528),             # no need
    (New-UString 0x4E0D, 0x7528, 0x4E86),     # no need now
    (New-UString 0x7B97, 0x4E86),             # forget it
    (New-UString 0x5148, 0x4E0D, 0x7528),     # not now
    (New-UString 0x53D6, 0x6D88)              # cancel
  )
  CUSTOMER_MODIFY_REQUEST = @(
    (New-UString 0x6539, 0x5730, 0x5740),     # change address
    (New-UString 0x63DB, 0x5730, 0x5740),     # switch address
    (New-UString 0x6539, 0x6642, 0x9593),     # change time
    (New-UString 0x6539, 0x4E0B, 0x8ECA),     # change dropoff
    (New-UString 0x6539)                      # change
  )
  CUSTOMER_STATUS_QUESTION = @(
    (New-UString 0x5230, 0x4E86, 0x55CE),     # arrived?
    (New-UString 0x5230, 0x54EA),             # where now
    (New-UString 0x591A, 0x4E45),             # how long
    (New-UString 0x53F8, 0x6A5F, 0x591A, 0x4E45, 0x5230), # driver how long to arrive
    (New-UString 0x8ECA, 0x724C)              # plate
  )
  CUSTOMER_RUSH = @(
    (New-UString 0x5FEB, 0x9EDE),             # hurry
    (New-UString 0x8D95, 0x5FEB),             # hurry
    (New-UString 0x7B49, 0x5F88, 0x4E45)      # waited long
  )
  CUSTOMER_PRICE_QUESTION = @(
    (New-UString 0x591A, 0x5C11, 0x9322),     # how much
    (New-UString 0x8ECA, 0x8CC7),             # fare
    (New-UString 0x50F9, 0x683C)              # price
  )
  CUSTOMER_LOCATION_STATUS = @(
    (New-UString 0x6211, 0x5728, 0x6A13, 0x4E0B), # I am downstairs
    (New-UString 0x6211, 0x5230, 0x4E86),         # I arrived
    (New-UString 0x5728, 0x9580, 0x53E3)          # at entrance
  )
  CUSTOMER_THANKS = @(
    (New-UString 0x8B1D, 0x8B1D)              # thanks
  )
  CUSTOMER_ACK = @(
    'OK',
    'ok',
    (New-UString 0x597D),                     # ok
    (New-UString 0x597D, 0x7684),             # okay
    (New-UString 0x6536, 0x5230),             # received
    (New-UString 0x4E86, 0x89E3),             # understand
    (New-UString 0x55EF),                     # mm/ok
    (New-UString 0x5C0D)                      # yes/right
  )
}

function Import-RequiredCsv {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Required manifest not found: $Path"
  }
  return Import-Csv -LiteralPath $Path -Encoding UTF8
}

function Get-HermesRowsByFolder {
  param([array] $Rows)
  $map = @{}
  foreach ($row in $Rows) {
    $map[$row.Folder] = $row
  }
  return $map
}

function Get-Candidate36Rows {
  $qualityRows = Import-RequiredCsv -Path $DataQualityPath
  $hermesRows = Import-RequiredCsv -Path $HermesManifestPath
  $hermesByFolder = Get-HermesRowsByFolder -Rows $hermesRows

  $rows = @()
  foreach ($q in $qualityRows) {
    if ($q.CandidateUsable -ne 'True') { continue }

    $folder = [string] $q.Folder
    $root = Join-Path $CandidateRoot $folder
    $finalPath = Join-Path $root 'final_chat.txt'
    $infoPath = Join-Path $root 'customer_info.txt'
    $h = $null
    if ($hermesByFolder.ContainsKey($folder)) {
      $h = $hermesByFolder[$folder]
    }

    $category = ''
    if ($null -ne $h) { $category = [string] $h.Category }

    $rows += [pscustomobject]@{
      Folder = $folder
      Category = $category
      ChatType = [string] $q.ChatType
      CandidateUsable = [string] $q.CandidateUsable
      HasFinal = [string] $q.HasFinal
      HasInfo = [string] $q.HasInfo
      Duplicate = [string] $q.Duplicate
      LooksGarbled = [string] $q.LooksGarbled
      ManifestLength = [string] $q.Length
      ManifestChineseChars = [string] $q.ChineseChars
      RootPath = $root
      FinalChatPath = $finalPath
      CustomerInfoPath = $infoPath
      RootExists = [bool] (Test-Path -LiteralPath $root)
      FinalChatExists = [bool] (Test-Path -LiteralPath $finalPath)
      CustomerInfoExists = [bool] (Test-Path -LiteralPath $infoPath)
    }
  }

  return $rows | Sort-Object Folder
}

function Add-UniqueWarning {
  param(
    [System.Collections.Generic.List[string]] $Warnings,
    [string] $Message
  )
  if (-not $Warnings.Contains($Message)) {
    [void] $Warnings.Add($Message)
  }
}

function Get-ChineseCharCount {
  param([string] $Text)
  return ([regex]::Matches([string] $Text, '[\u4e00-\u9fff]')).Count
}

function Get-TextStats {
  param([string] $Text)
  $s = [string] $Text
  $lines = @()
  if ($s.Length -gt 0) {
    $lines = $s -split "`r?`n"
  }
  return [pscustomobject]@{
    lineCount = @($lines).Count
    charCount = $s.Length
    chineseCharCount = Get-ChineseCharCount -Text $s
  }
}

function Test-IsSystemLine {
  param([string] $Line)
  $t = $Line.Trim()
  if ([string]::IsNullOrWhiteSpace($t)) { return $true }
  if ($t -match '^\d{1,2}:\d{2}$') { return $true }
  if ($t -match '^\d{1,2}/\d{1,2}') { return $true }
  if ($t -match '^_+$') { return $true }
  if ($t -match '^[= _-]+$') { return $true }
  return $false
}

function Test-HasAddressMarker {
  param([string] $Line)
  foreach ($kw in $Script:AddressChars) {
    if ($Line.Contains($kw)) { return $true }
  }
  return $false
}

function Test-IsStrongAddressLine {
  param([string] $Line)
  if ($Line -match '\d{1,4}\s*[\u865F\u6A13\u5DF7\u5F04]') { return $true }
  foreach ($kw in $Script:StrongAddressChars) {
    if ($Line.Contains($kw)) { return $true }
  }
  return $false
}

function Test-IsShortAllowedReply {
  param([string] $Line)
  $t = $Line.Trim()
  foreach ($reply in $Script:ShortReplyAllowList) {
    if ($t -eq $reply) { return $true }
  }
  return $false
}

function Convert-BehaviorSignalLine {
  param([string] $Line)
  $t = $Line.Trim()
  if ([string]::IsNullOrWhiteSpace($t)) { return $null }

  foreach ($entry in $Script:BehaviorSignalTerms.GetEnumerator()) {
    foreach ($term in $entry.Value) {
      if ([string]::IsNullOrWhiteSpace($term)) { continue }
      if ($t -eq $term -or $t.Contains($term)) {
        return ('[{0}]' -f $entry.Key)
      }
    }
  }

  return $null
}

function Test-IsBehaviorSignalLine {
  param([string] $Line)
  return $null -ne (Convert-BehaviorSignalLine -Line $Line)
}

function Redact-Line {
  param(
    [string] $Line,
    [System.Collections.Generic.List[string]] $Warnings
  )

  $lineOut = [string] $Line
  $trimmed = $lineOut.Trim()

  if (Test-IsSystemLine -Line $trimmed) { return $lineOut }

  if ($lineOut -match '09\d{8}') {
    Add-UniqueWarning -Warnings $Warnings -Message 'Matched Taiwan mobile phone; replaced with [PHONE].'
    $lineOut = [regex]::Replace($lineOut, '09\d{8}', $Script:TokPhone)
  }

  if ($lineOut -match '\b[A-Z]{1,4}[-\s]?\d{3,4}\b') {
    Add-UniqueWarning -Warnings $Warnings -Message 'Matched possible vehicle plate; replaced with [PLATE].'
    $lineOut = [regex]::Replace($lineOut, '\b[A-Z]{1,4}[-\s]?\d{3,4}\b', $Script:TokPlate, 'IgnoreCase')
  }

  if ($lineOut -match '\b[UC][0-9a-fA-F]{20,}\b') {
    Add-UniqueWarning -Warnings $Warnings -Message 'Matched possible LINE UserId/ChatId; replaced with [ID].'
    $lineOut = [regex]::Replace($lineOut, '\b[UC][0-9a-fA-F]{20,}\b', $Script:TokId)
  }

  if ($lineOut -match '@[A-Za-z0-9._-]{4,}') {
    Add-UniqueWarning -Warnings $Warnings -Message 'Matched possible LINE handle; replaced with [ID].'
    $lineOut = [regex]::Replace($lineOut, '@[A-Za-z0-9._-]{4,}', $Script:TokId)
  }

  if (Test-IsStrongAddressLine -Line $lineOut) {
    Add-UniqueWarning -Warnings $Warnings -Message 'Matched address-like content; replaced line with [ADDRESS].'
    return $Script:TokAddress
  }

  if ($trimmed.Length -le 16) {
    $behaviorToken = Convert-BehaviorSignalLine -Line $trimmed
    if ($null -ne $behaviorToken) {
      Add-UniqueWarning -Warnings $Warnings -Message ('Matched customer behavior signal; replaced with {0}.' -f $behaviorToken)
      return $behaviorToken
    }
  }

  if (Test-HasAddressMarker -Line $lineOut) {
    Add-UniqueWarning -Warnings $Warnings -Message 'Matched address-like content; replaced line with [ADDRESS].'
    return $Script:TokAddress
  }

  $driverWord = -join @([char]0x53F8, [char]0x6A5F)
  $plateWord = -join @([char]0x8ECA, [char]0x724C)
  $carWord = -join @([char]0x8ECA)
  if ($lineOut.Contains($driverWord)) {
    Add-UniqueWarning -Warnings $Warnings -Message 'Matched driver keyword; replaced line with [DISPATCH_INFO].'
    return $Script:TokDispatchInfo
  }
  if ($lineOut.Contains($plateWord)) {
    Add-UniqueWarning -Warnings $Warnings -Message 'Matched plate keyword; replaced line with [DISPATCH_INFO].'
    return $Script:TokDispatchInfo
  }
  if ($lineOut.Contains($carWord) -and $lineOut -match '\d') {
    Add-UniqueWarning -Warnings $Warnings -Message 'Matched vehicle-like line; replaced line with [DISPATCH_INFO].'
    return $Script:TokDispatchInfo
  }

  if ($trimmed.Length -le 16 -and $trimmed -match '[^\u0000-\u007F]' -and -not (Test-IsShortAllowedReply -Line $trimmed)) {
    Add-UniqueWarning -Warnings $Warnings -Message 'Matched possible display name or nickname; replaced with [NAME].'
    return $Script:TokName
  }

  return $lineOut
}

function Convert-ToDeidentifiedText {
  param(
    [string] $RawText,
    [System.Collections.Generic.List[string]] $Warnings
  )

  $lines = [string] $RawText -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    [void] $out.Add((Redact-Line -Line $line -Warnings $Warnings))
  }
  return ($out -join "`r`n")
}

function Invoke-PrivacyScan {
  param([string] $Text)

  $s = [string] $Text
  $flags = [ordered]@{
    phone = ([regex]::Matches($s, '09\d{8}')).Count
    vehiclePlate = ([regex]::Matches($s, '\b[A-Z]{1,4}[-\s]?\d{3,4}\b', 'IgnoreCase')).Count
    lineIdOrChatId = ([regex]::Matches($s, '\b[UC][0-9a-fA-F]{20,}\b')).Count
    lineHandle = ([regex]::Matches($s, '@[A-Za-z0-9._-]{4,}')).Count
    address = 0
    possibleName = 0
  }

  foreach ($line in ($s -split "`r?`n")) {
    $t = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    if ($t -match '^\[.+\]$') { continue }
    if ((Test-HasAddressMarker -Line $t) -or ($t -match '\d{1,4}\s*[\u865F\u6A13\u5DF7\u5F04]')) {
      $flags.address++
    }
    if ($t.Length -le 6 -and $t -match '^[\u4e00-\u9fff]{2,6}$' -and -not (Test-IsShortAllowedReply -Line $t)) {
      $flags.possibleName++
    }
  }

  return [pscustomobject]$flags
}

function Test-HasPrivacyFlag {
  param([pscustomobject] $Flags)
  foreach ($prop in $Flags.PSObject.Properties) {
    if ([int] $prop.Value -gt 0) { return $true }
  }
  return $false
}

function New-OutputDirectories {
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $root = Join-Path $TrainingOutputRoot "candidate_usable_36_$stamp"
  $dirs = @(
    $root,
    (Join-Path $root 'samples'),
    (Join-Path $root 'manifests'),
    (Join-Path $root 'privacy_scan'),
    (Join-Path $root 'reports')
  )
  foreach ($dir in $dirs) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  return $root
}

function Write-DryRunSummary {
  param([array] $Rows)

  $summary = [pscustomobject]@{
    CandidateUsable = @($Rows).Count
    RootExists = @($Rows | Where-Object { $_.RootExists }).Count
    FinalChatExists = @($Rows | Where-Object { $_.FinalChatExists }).Count
    CustomerInfoExists = @($Rows | Where-Object { $_.CustomerInfoExists }).Count
    LooksGarbledTrue = @($Rows | Where-Object { $_.LooksGarbled -eq 'True' }).Count
    DuplicateTrue = @($Rows | Where-Object { $_.Duplicate -eq 'True' }).Count
    Direct = @($Rows | Where-Object { $_.ChatType -eq 'direct' }).Count
    Unknown = @($Rows | Where-Object { $_.ChatType -eq 'unknown' }).Count
  }

  Write-Output 'DRY RUN ONLY - final_chat.txt was not read and no output files were created.'
  $summary | Format-List
  $Rows |
    Select-Object Folder, Category, ChatType, RootExists, FinalChatExists, CustomerInfoExists, LooksGarbled, Duplicate |
    Format-Table -AutoSize
}

function Invoke-Candidate36Run {
  param([array] $Rows)

  if (@($Rows).Count -ne 36) {
    throw "Expected 36 CandidateUsable rows, got $(@($Rows).Count)."
  }

  $outputRoot = New-OutputDirectories
  $samplesDir = Join-Path $outputRoot 'samples'
  $manifestPath = Join-Path $outputRoot 'manifests\candidate_usable_36_deidentified_manifest.csv'
  $privacyReportPath = Join-Path $outputRoot 'privacy_scan\privacy_scan_report.md'
  $summaryReportPath = Join-Path $outputRoot 'reports\deidentify_candidate36_summary.md'

  $manifestRows = @()
  $privacyRows = @()

  foreach ($row in $Rows) {
    if (-not $row.FinalChatExists) {
      throw "Missing final_chat.txt for $($row.Folder)"
    }

    $raw = Get-Content -LiteralPath $row.FinalChatPath -Raw -Encoding UTF8
    $warnings = New-Object System.Collections.Generic.List[string]
    $redacted = Convert-ToDeidentifiedText -RawText $raw -Warnings $warnings

    if ($MaxLines -gt 0) {
      $redacted = (($redacted -split "`r?`n") | Select-Object -First $MaxLines) -join "`r`n"
    }
    if ($MaxChars -gt 0 -and $redacted.Length -gt $MaxChars) {
      $redacted = $redacted.Substring(0, $MaxChars)
      Add-UniqueWarning -Warnings $warnings -Message "Truncated deidentified text to MaxChars=$MaxChars."
    }

    $flags = Invoke-PrivacyScan -Text $redacted
    $needsManualReview = Test-HasPrivacyFlag -Flags $flags
    $stats = Get-TextStats -Text $redacted

    $sample = [ordered]@{
      sourceFolder = $row.Folder
      sourceCategory = $row.Category
      candidateUsable = $row.CandidateUsable
      chatType = $row.ChatType
      deidentifiedText = $redacted
      warnings = @($warnings)
      privacyFlags = $flags
      needsManualReview = $needsManualReview
      sourceStats = $stats
    }

    $samplePath = Join-Path $samplesDir "$($row.Folder)_deidentified.json"
    $sample | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $samplePath -Encoding UTF8

    $manifestRows += [pscustomobject]@{
      sourceFolder = $row.Folder
      sourceCategory = $row.Category
      candidateUsable = $row.CandidateUsable
      chatType = $row.ChatType
      finalChatExists = $row.FinalChatExists
      customerInfoExists = $row.CustomerInfoExists
      outputFile = "samples/$($row.Folder)_deidentified.json"
      warningCount = @($warnings).Count
      needsManualReview = $needsManualReview
      lineCount = $stats.lineCount
      charCount = $stats.charCount
      chineseCharCount = $stats.chineseCharCount
      phoneFlags = $flags.phone
      vehiclePlateFlags = $flags.vehiclePlate
      lineIdOrChatIdFlags = $flags.lineIdOrChatId
      lineHandleFlags = $flags.lineHandle
      addressFlags = $flags.address
      possibleNameFlags = $flags.possibleName
    }

    $privacyRows += [pscustomobject]@{
      sourceFolder = $row.Folder
      needsManualReview = $needsManualReview
      phone = $flags.phone
      vehiclePlate = $flags.vehiclePlate
      lineIdOrChatId = $flags.lineIdOrChatId
      lineHandle = $flags.lineHandle
      address = $flags.address
      possibleName = $flags.possibleName
    }
  }

  $manifestRows | Export-Csv -LiteralPath $manifestPath -NoTypeInformation -Encoding UTF8

  $privacyLines = New-Object System.Collections.Generic.List[string]
  [void] $privacyLines.Add('# Candidate36 Privacy Scan Report')
  [void] $privacyLines.Add('')
  [void] $privacyLines.Add('This report contains counts only. It does not include raw text or matched snippets.')
  [void] $privacyLines.Add('')
  [void] $privacyLines.Add('| sourceFolder | needsManualReview | phone | vehiclePlate | lineIdOrChatId | lineHandle | address | possibleName |')
  [void] $privacyLines.Add('|---|---:|---:|---:|---:|---:|---:|---:|')
  foreach ($p in $privacyRows) {
    [void] $privacyLines.Add("| $($p.sourceFolder) | $($p.needsManualReview) | $($p.phone) | $($p.vehiclePlate) | $($p.lineIdOrChatId) | $($p.lineHandle) | $($p.address) | $($p.possibleName) |")
  }
  Set-Content -LiteralPath $privacyReportPath -Value $privacyLines -Encoding UTF8

  $summaryLines = @(
    '# Candidate36 Deidentify Summary',
    '',
    "- Output root: $outputRoot",
    "- CandidateUsable rows: $(@($Rows).Count)",
    "- Output samples: $(@($manifestRows).Count)",
    "- Needs manual review: $(@($manifestRows | Where-Object { $_.needsManualReview }).Count)",
    "- customer_info.txt read: no",
    "- raw text included in reports: no"
  )
  Set-Content -LiteralPath $summaryReportPath -Value $summaryLines -Encoding UTF8

  Write-Output "Run complete. Output root: $outputRoot"
}

$candidateRows = @(Get-Candidate36Rows)

if (-not $Run) {
  Write-DryRunSummary -Rows $candidateRows
  return
}

Invoke-Candidate36Run -Rows $candidateRows
