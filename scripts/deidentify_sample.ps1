#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 1 de-identified sampling for direct manifest rows only.

.DESCRIPTION
  - Trusts manifest fields only (no CandidateUsable recompute).
  - Default: dry-run listing of direct candidates (no final_chat read).
  - Use -Folder to sample one allowed direct folder.
  - Does not read customer_info.txt or unknown/garbled rows.
#>
[CmdletBinding()]
param(
  [switch] $DryRun,
  [string] $Folder,
  [int] $MaxLines = 20,
  [int] $MaxChars = 3000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataQualityPath = Join-Path $RepoRoot 'data_quality_manifest.csv'
$HermesManifestPath = Join-Path $RepoRoot 'hermes_training_pack_20260523_040314\hermes_training_manifest.csv'
$CandidateRoot = Join-Path $RepoRoot 'hermes_candidate_usable_data'
$OutputRoot = Join-Path $RepoRoot 'training_deidentified_output\samples'

# Redaction tokens (ASCII-safe script; Unicode tokens built at runtime)
$Script:TokPhone = "[$([char]0x96FB)$([char]0x8A71)]"
$Script:TokPlate = "[$([char]0x8ECA)$([char]0x724C)]"
$Script:TokAddress = "[$([char]0x5730)$([char]0x5740)]"
$Script:TokId = '[ID]'
$Script:TokName = "[$([char]0x59D3)$([char]0x540D)]"
$Script:TokCustomer = "[$([char]0x5BA2)$([char]0x4EBA)]"
$Script:TokDispatcher = "[$([char]0x6D3E)$([char]0x55AE)$([char]0x54E1)]"
$Script:TokDriver = "[$([char]0x53F8)$([char]0x6A5F)]"
$Script:TokDispatchInfo = "[$([char]0x6D3E)$([char]0x8ECA)$([char]0x8CC7)$([char]0x8A0A)]"
# Address keywords (exclude li/里 char code — avoids false match inside mileage/里程)
$Script:AddressKeywordList = @(
  [char]0x5E02, [char]0x7E23, [char]0x5340, [char]0x9109, [char]0x939A,
  [char]0x8DEF, [char]0x8857, [char]0x5DF7, [char]0x5F04, [char]0x865F, [char]0x6A13, [char]0x6BB5
) | ForEach-Object { [string]$_ }
$Script:MileageWord = -join @([char]0x91CC, [char]0x7A0B)
$Script:ShortReplyBlocklist = @(
  [char]0x597D, [char]0x5C0D, [char]0x662F, [char]0x55EF, [char]0x54E6, [char]0x554A,
  [char]0x6536, [char]0x53EF, [char]0x884C, [char]0x5728, [char]0x55E8, [char]0x7684,
  [char]0x8B1D, [char]0x4E56, [char]0x55EF
) | ForEach-Object { [string]$_ }
$Script:ShortReplyBlocklist += @(
  -join @([char]0x6536, [char]0x5230),
  -join @([char]0x53D6, [char]0x6D88),
  -join @([char]0x597D, [char]0x7684),
  -join @([char]0x660E, [char]0x767D),
  -join @([char]0x4E86, [char]0x89E3),
  -join @([char]0x6C92, [char]0x554F, [char]0x984C),
  -join @([char]0x4E0D, [char]0x884C),
  -join @([char]0x53EF, [char]0x4EE5),
  -join @([char]0x90A3, [char]0x7B97, [char]0x4E86),
  -join @([char]0x53D6, [char]0x6D88, [char]0x55CE)
) | Select-Object -Unique

function Write-ErrorAndExit {
  param([string] $Message)
  Write-Error $Message
  exit 1
}

function Import-ManifestCsv {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    Write-ErrorAndExit "Manifest not found: $Path"
  }
  Import-Csv -LiteralPath $Path -Encoding UTF8
}

function Test-IsDirectRow {
  param(
    [pscustomobject] $QualityRow,
    [pscustomobject] $HermesRow
  )

  if ($QualityRow.CandidateUsable -ne 'True') { return $false }
  if ($QualityRow.LooksGarbled -eq 'True') { return $false }
  if ($HermesRow.Category -notmatch 'direct' -and $HermesRow.ChatType -ne 'direct') { return $false }
  return $true
}

function Get-DirectCandidates {
  $quality = Import-ManifestCsv -Path $DataQualityPath
  $hermes = Import-ManifestCsv -Path $HermesManifestPath
  $hermesByFolder = @{}
  foreach ($row in $hermes) {
    $hermesByFolder[$row.Folder] = $row
  }

  $results = @()
  foreach ($q in $quality) {
    if (-not $hermesByFolder.ContainsKey($q.Folder)) { continue }
    $h = $hermesByFolder[$q.Folder]
    if (-not (Test-IsDirectRow -QualityRow $q -HermesRow $h)) { continue }

    $results += [pscustomobject]@{
      Folder       = $q.Folder
      Category     = $h.Category
      ChatType     = $h.ChatType
      LooksGarbled = $q.LooksGarbled
      CandidateUsable = $q.CandidateUsable
      HasFinal     = $q.HasFinal
      ChineseChars = $q.ChineseChars
      Length       = $q.Length
    }
  }

  return $results | Sort-Object Folder
}

function Add-Warning {
  param(
    [ref] $WarningList,
    [string] $Message
  )
  if ($WarningList.Value -notcontains $Message) {
    $WarningList.Value += $Message
  }
}

function Test-IsChatSystemLine {
  param([string] $Line)

  $trimmed = $Line.Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) { return $true }
  if ($trimmed -match '^\d{1,2}:\d{2}$') { return $true }
  if ($trimmed -match '^\d{1,2}/\d{1,2}') { return $true }
  if ($trimmed -eq (-join @([char]0x5DF2, [char]0x8B80))) { return $true }
  if ($trimmed -match '^_+$') { return $true }
  if ($trimmed -match '^[=≡]+$') { return $true }
  return $false
}

function Test-LineHasAddressKeyword {
  param([string] $Line)

  if ($Line.Contains($Script:MileageWord)) {
    return $false
  }

  foreach ($kw in $Script:AddressKeywordList) {
    if ($Line.Contains($kw)) {
      return $true
    }
  }
  return $false
}

function Test-IsEmojiDisplayNameLine {
  param([string] $Line)

  $trimmed = $Line.Trim()
  if ($trimmed.Length -gt 30) { return $false }
  if ($trimmed -match '(司機|駕駛|派車|客服|回報|感謝|取消|叫車|尋車|分鐘|地址|上車|下車)') {
    return $false
  }

  $hasEmoji = $false
  if ($trimmed -match '[\uD800-\uDBFF][\uDC00-\uDFFF]') { $hasEmoji = $true }
  if ($trimmed -match '[^\u0000-\u007F\u4e00-\u9fff\s，。！？、．：；\-_\[\]（）()]') { $hasEmoji = $true }

  if (-not $hasEmoji) { return $false }
  if ($trimmed.Length -le 20) { return $true }

  $cjkCount = ([regex]::Matches($trimmed, '[\u4e00-\u9fff]')).Count
  return ($cjkCount -le 6)
}

function Invoke-DispatchAndRouteRedactionForLine {
  param(
    [string] $Line,
    [ref] $Warnings
  )

  $trimmed = $Line.Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    return $Line
  }

  if ($trimmed -match '(司機資訊|派車資訊|駕駛資訊)') {
    Add-Warning -WarningList $Warnings -Message "Matched dispatch info header; replaced with $Script:TokDispatchInfo."
    return $Script:TokDispatchInfo
  }

  if ($trimmed -match '^(上車|下車|起點|終點|上車地點|下車地點)[：:]\s*(.+)$') {
    Add-Warning -WarningList $Warnings -Message "Matched route field; replaced value with $Script:TokAddress."
    $label = $matches[1]
    $colon = if ($trimmed.Contains(':')) { ':' } else { '：' }
    return "$label$colon$Script:TokAddress"
  }

  if ($trimmed -match '^(司機|駕駛)[：:]\s*(.+)$') {
    Add-Warning -WarningList $Warnings -Message "Matched driver field; replaced with $Script:TokDriver."
    $label = $matches[1]
    $colon = if ($trimmed.Contains(':')) { ':' } else { '：' }
    return "$label$colon$Script:TokDriver"
  }

  if ($trimmed -match '^(車牌|車號)[：:]\s*(.+)$') {
    Add-Warning -WarningList $Warnings -Message "Matched plate field; replaced with $Script:TokPlate."
    $label = $matches[1]
    $colon = if ($trimmed.Contains(':')) { ':' } else { '：' }
    return "$label$colon$Script:TokPlate"
  }

  if ($trimmed -match '^(車型|車款|車色|顏色)[：:]\s*(.+)$') {
    Add-Warning -WarningList $Warnings -Message "Matched vehicle detail field; replaced with $Script:TokDispatchInfo."
    return $Script:TokDispatchInfo
  }

  if ($trimmed -match '(車牌|車號)') {
    Add-Warning -WarningList $Warnings -Message "Matched plate keyword in line; replaced line with $Script:TokDispatchInfo."
    return $Script:TokDispatchInfo
  }

  return $null
}

function Invoke-EnglishPrefixRedactionForLine {
  param(
    [string] $Line,
    [ref] $Warnings
  )

  if ($Line -match '^(?<prefix>[A-Za-z]{2,15})(?<rest>[\u4e00-\u9fff].*)$') {
    Add-Warning -WarningList $Warnings -Message "Matched English staff prefix; replaced with $Script:TokDispatcher."
    return ($Script:TokDispatcher + $Matches['rest'])
  }
  return $Line
}

function Invoke-EmojiDisplayNameRedactionForLine {
  param(
    [string] $Line,
    [ref] $Warnings
  )

  if (Test-IsEmojiDisplayNameLine -Line $Line) {
    Add-Warning -WarningList $Warnings -Message "Matched emoji display name; replaced with $Script:TokName."
    return $Script:TokName
  }
  return $Line
}

function Invoke-NameRedactionForLine {
  param(
    [string] $Line,
    [ref] $Warnings
  )

  if ([string]::IsNullOrWhiteSpace($Line)) {
    return $Line
  }

  $trimmed = $Line.Trim()
  if (Test-IsChatSystemLine -Line $trimmed) {
    return $Line
  }

  $driverWord = -join @([char]0x53F8, [char]0x6A5F)
  $dispatchWord = -join @([char]0x6D3E, [char]0x55AE)
  $serviceWord = -join @([char]0x5BA2, [char]0x670D)

  if ($trimmed -eq $driverWord) {
    Add-Warning -WarningList $Warnings -Message "Matched speaker role line; replaced with $Script:TokDriver."
    return $Script:TokDriver
  }
  if ($trimmed -match "^$dispatchWord" -or $trimmed -match "^$serviceWord") {
    Add-Warning -WarningList $Warnings -Message "Matched speaker role line; replaced with $Script:TokDispatcher."
    return $Script:TokDispatcher
  }

  $updated = $Line
  $titlePattern = '([\u4e00-\u9fffA-Za-z]{1,6})(先生|小姐|女士|太太|師兄|師姐)'
  if ($updated -match $titlePattern) {
    Add-Warning -WarningList $Warnings -Message "Matched honorific/title pattern; replaced with $Script:TokName."
    $updated = [regex]::Replace($updated, $titlePattern, $Script:TokName)
  }

  $gePattern = '([\u4e00-\u9fff]{1,4})(哥|姐)(?![哥姐])'
  if ($updated -match $gePattern) {
    Add-Warning -WarningList $Warnings -Message "Matched nickname with 哥/姐; replaced with $Script:TokName."
    $updated = [regex]::Replace($updated, $gePattern, $Script:TokName)
  }

  $standalonePattern = '^[\u4e00-\u9fff]{1,6}$'
  if ($trimmed -match $standalonePattern -and $Script:ShortReplyBlocklist -notcontains $trimmed) {
    Add-Warning -WarningList $Warnings -Message "Matched possible LINE display name; replaced with $Script:TokCustomer."
    return $Script:TokCustomer
  }

  return $updated
}

function Add-PossibleNameRemainingWarnings {
  param(
    [string] $Text,
    [ref] $Warnings
  )

  $tokenValues = @(
    $Script:TokName, $Script:TokCustomer, $Script:TokDispatcher, $Script:TokDriver,
    $Script:TokAddress, $Script:TokPhone, $Script:TokPlate, $Script:TokId, $Script:TokDispatchInfo
  )

  $lines = $Text -split "\r?\n"
  foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
    if (Test-IsChatSystemLine -Line $trimmed) { continue }
    if ($tokenValues -contains $trimmed) { continue }

    $maybeName = $false
    if ($trimmed -match '^[\u4e00-\u9fff]{2,8}$' -and $Script:ShortReplyBlocklist -notcontains $trimmed) {
      $maybeName = $true
    }
    if ($trimmed -match '(先生|小姐|女士|太太|師兄|師姐)') {
      $maybeName = $true
    }
    if ($trimmed -match '[\u4e00-\u9fff]{1,4}(哥|姐)(?![哥姐])') {
      $maybeName = $true
    }

    if ($maybeName) {
      Add-Warning -WarningList $Warnings -Message 'possible_name_or_nickname_remaining'
      break
    }
  }
}

function Invoke-DeidentifyText {
  param(
    [string] $Text,
    [ref] $Warnings
  )

  if ([string]::IsNullOrEmpty($Text)) {
    return ''
  }

  $result = $Text

  # URLs (including ChatUrl-like values)
  $urlPattern = '(?i)\b(?:https?://|line://)[^\s\]]+'
  if ($result -match $urlPattern) {
    Add-Warning -WarningList $Warnings -Message 'Matched URL pattern; replaced with [ID].'
    $result = [regex]::Replace($result, $urlPattern, $Script:TokId)
  }

  # LINE / long opaque IDs (U-prefix userId, long hex/base64-ish tokens)
  $lineIdPattern = '(?i)\bU[a-f0-9]{20,}\b'
  if ($result -match $lineIdPattern) {
    Add-Warning -WarningList $Warnings -Message 'Matched LINE-style ID; replaced with [ID].'
    $result = [regex]::Replace($result, $lineIdPattern, $Script:TokId)
  }

  $longTokenPattern = '(?i)\b[a-z0-9_-]{24,}\b'
  if ($result -match $longTokenPattern) {
    Add-Warning -WarningList $Warnings -Message 'Matched long opaque token; replaced with [ID].'
    $result = [regex]::Replace($result, $longTokenPattern, $Script:TokId)
  }

  # Phone numbers and 8+ digit runs (line-level later; skip global plate regex in v1.2)
  $phonePattern = '(?<!\d)(?:\+?886[-\s]?)?0?\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}\b|\b\d{8,}\b'
  if ($result -match $phonePattern) {
    Add-Warning -WarningList $Warnings -Message "Matched phone or long digit run; replaced with $Script:TokPhone."
    $result = [regex]::Replace($result, $phonePattern, $Script:TokPhone)
  }

  $lineEnding = [Environment]::NewLine
  $lineList = $result -split "\r?\n"
  $redactedLines = foreach ($line in $lineList) {
    $trimmed = $line.Trim()
    if (Test-IsChatSystemLine -Line $trimmed) {
      $line
      continue
    }

    $dispatchRedacted = Invoke-DispatchAndRouteRedactionForLine -Line $line -Warnings $Warnings
    if ($null -ne $dispatchRedacted) {
      $dispatchRedacted
      continue
    }

    $emojiRedacted = Invoke-EmojiDisplayNameRedactionForLine -Line $line -Warnings $Warnings
    if ($emojiRedacted -ne $line) {
      $emojiRedacted
      continue
    }

    $englishRedacted = Invoke-EnglishPrefixRedactionForLine -Line $line -Warnings $Warnings
    if ($englishRedacted -ne $line) {
      $englishRedacted
      continue
    }

    if (Test-LineHasAddressKeyword -Line $line) {
      Add-Warning -WarningList $Warnings -Message "Matched address-like line; replaced with $Script:TokAddress."
      $Script:TokAddress
      continue
    }

    Invoke-NameRedactionForLine -Line $line -Warnings $Warnings
  }
  $result = $redactedLines -join $lineEnding

  Add-PossibleNameRemainingWarnings -Text $result -Warnings $Warnings

  return $result
}

function Read-LimitedChatText {
  param(
    [string] $Path,
    [int] $LineLimit,
    [int] $CharLimit
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    Write-ErrorAndExit "final_chat.txt not found: $Path"
  }

  $lines = New-Object System.Collections.Generic.List[string]
  $charCount = 0
  $reader = [System.IO.StreamReader]::new($Path, [System.Text.Encoding]::UTF8, $true)

  try {
    while ($null -ne ($line = $reader.ReadLine())) {
      if ($lines.Count -ge $LineLimit) { break }
      if ($charCount + $line.Length -gt $CharLimit -and $lines.Count -gt 0) { break }

      $remaining = $CharLimit - $charCount
      if ($line.Length -gt $remaining) {
        $lines.Add($line.Substring(0, $remaining))
        $charCount += $remaining
        break
      }

      $lines.Add($line)
      $charCount += $line.Length
      if ($charCount -ge $CharLimit) { break }
    }
  }
  finally {
    $reader.Close()
  }

  return ($lines -join [Environment]::NewLine)
}

function Show-DryRun {
  param([array] $Candidates)

  Write-Host '=== deidentify_sample.ps1 (dry-run) ==='
  Write-Host "Direct candidate count: $($Candidates.Count)"
  Write-Host 'Filters: CandidateUsable=True, LooksGarbled=False, Category~direct OR ChatType=direct'
  Write-Host 'No final_chat.txt read in dry-run mode.'
  Write-Host ''

  foreach ($c in $Candidates) {
    Write-Host ("- {0} | Category={1} | ChatType={2} | ChineseChars={3} | Length={4}" -f `
      $c.Folder, $c.Category, $c.ChatType, $c.ChineseChars, $c.Length)
  }

  Write-Host ''
  Write-Host 'To sample one folder:'
  Write-Host '  .\scripts\deidentify_sample.ps1 -Folder customer_text_YYYYMMDD_HHMMSS -MaxLines 20'
}

function Export-Sample {
  param(
    [pscustomobject] $Candidate,
    [int] $LineLimit,
    [int] $CharLimit
  )

  $sourceFile = Join-Path $CandidateRoot (Join-Path $Candidate.Folder 'final_chat.txt')
  $rawText = Read-LimitedChatText -Path $sourceFile -LineLimit $LineLimit -CharLimit $CharLimit
  $warnings = @()
  $deidentified = Invoke-DeidentifyText -Text $rawText -Warnings ([ref]$warnings)

  if (-not (Test-Path -LiteralPath $OutputRoot)) {
    New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
  }

  $payload = [ordered]@{
    folder           = $Candidate.Folder
    category         = $Candidate.Category
    chatType         = $Candidate.ChatType
    sourceFile       = "hermes_candidate_usable_data/$($Candidate.Folder)/final_chat.txt"
    maxLines         = $LineLimit
    maxChars         = $CharLimit
    deidentifiedText = $deidentified
    warnings         = $warnings
  }

  $outputName = "{0}_sample.json" -f $Candidate.Folder
  $outputPath = Join-Path $OutputRoot $outputName
  $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $outputPath -Encoding UTF8

  Write-Host "Wrote de-identified sample: $outputPath"
  return $outputPath
}

$candidates = @(Get-DirectCandidates)
$shouldDryRun = $DryRun -or [string]::IsNullOrWhiteSpace($Folder)

if ($shouldDryRun) {
  Show-DryRun -Candidates $candidates
  exit 0
}

$target = $candidates | Where-Object { $_.Folder -eq $Folder } | Select-Object -First 1
if (-not $target) {
  $quality = Import-ManifestCsv -Path $DataQualityPath | Where-Object { $_.Folder -eq $Folder } | Select-Object -First 1
  if ($quality) {
    if ($quality.LooksGarbled -eq 'True') {
      Write-ErrorAndExit "Rejected folder '$Folder': LooksGarbled=True."
    }
    if ($quality.CandidateUsable -ne 'True') {
      Write-ErrorAndExit "Rejected folder '$Folder': CandidateUsable is not True."
    }
    $hermes = Import-ManifestCsv -Path $HermesManifestPath | Where-Object { $_.Folder -eq $Folder } | Select-Object -First 1
    if ($hermes -and ($hermes.Category -notmatch 'direct' -and $hermes.ChatType -ne 'direct')) {
      Write-ErrorAndExit "Rejected folder '$Folder': not in direct allowlist (unknown/skipped/garbled not supported in v1)."
    }
  }
  Write-ErrorAndExit "Rejected folder '$Folder': not in direct candidate list."
}

Export-Sample -Candidate $target -LineLimit $MaxLines -CharLimit $MaxChars | Out-Null
