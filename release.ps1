[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'publish')]
    [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
$itemId = 'bbffbggibffkihciiafgjnmggomnbmme'
$configPath = Join-Path $PSScriptRoot 'release.local.json'
$distPath = Join-Path $PSScriptRoot 'dist'
$releaseLock = $null

function Get-Field($Object, [string]$Name) {
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) {
        return $Object.$Name
    }
    return $null
}

function Get-ReleaseVersion([string]$Value) {
    if ($Value -notmatch '^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$') { throw "Invalid extension version: $Value" }
    $parts = @($Value.Split('.') | ForEach-Object { [int]$_ })
    if (@($parts | Where-Object { $_ -gt 65535 }).Count -gt 0 -or ($parts | Measure-Object -Sum).Sum -eq 0) {
        throw "Invalid extension version: $Value"
    }
    while ($parts.Count -lt 4) { $parts += 0 }
    return [Version]::new($parts[0], $parts[1], $parts[2], $parts[3])
}

function Get-StoreStatus {
    $status = Invoke-RestMethod -Method Get -Uri "${itemUrl}:fetchStatus" -Headers $headers -TimeoutSec 60
    if ((Get-Field $status 'itemId') -ne $itemId) { throw 'Store returned a different extension. Stopping.' }
    return $status
}

function Assert-StoreReady($Status, [Version]$Version) {
    if ((Get-Field $Status 'takenDown') -eq $true -or (Get-Field $Status 'warned') -eq $true) {
        throw 'Store reports a policy warning or takedown. Resolve it in the dashboard before releasing.'
    }
    $submitted = Get-Field $Status 'submittedItemRevisionStatus'
    $state = Get-Field $submitted 'state'
    if ($state -and $state -notin @('CANCELLED', 'REJECTED', 'PUBLISHED')) {
        throw "An existing submission is $state. Check ./release.ps1 status before another release."
    }
    foreach ($channel in @(Get-Field (Get-Field $Status 'publishedItemRevisionStatus') 'distributionChannels')) {
        $publishedVersion = Get-Field $channel 'crxVersion'
        if ($publishedVersion -and $Version -le (Get-ReleaseVersion $publishedVersion)) {
            throw "Version $versionText is already published or older than $publishedVersion. Increase manifest.json version first."
        }
    }
}

function Show-StoreStatus($Status) {
    foreach ($revisionName in @('publishedItemRevisionStatus', 'submittedItemRevisionStatus')) {
        $revision = Get-Field $Status $revisionName
        if ($revision) {
            $label = if ($revisionName -eq 'publishedItemRevisionStatus') { 'Published' } else { 'Submission' }
            $versions = @(Get-Field $revision 'distributionChannels') | ForEach-Object { Get-Field $_ 'crxVersion' }
            Write-Output "$label`: $(Get-Field $revision 'state') $($versions -join ', ')"
        }
    }
    if (-not (Get-Field $Status 'publishedItemRevisionStatus') -and -not (Get-Field $Status 'submittedItemRevisionStatus')) {
        Write-Output 'No published or submitted revision.'
    }
    if (Get-Field $Status 'lastAsyncUploadState') { Write-Output "Last async upload: $($Status.lastAsyncUploadState)" }
    if ((Get-Field $Status 'warned') -eq $true) { Write-Output 'Policy warning: check the dashboard.' }
    if ((Get-Field $Status 'takenDown') -eq $true) { Write-Output 'Taken down: check the dashboard.' }
}

try {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw 'Missing release.local.json. Restore your local publishing settings before releasing.'
    }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    foreach ($field in @('projectId', 'serviceAccount', 'googleAccount', 'publisherId')) {
        if ([string]::IsNullOrWhiteSpace((Get-Field $config $field))) { throw "Missing $field in release.local.json." }
    }
    if ($config.projectId -notmatch '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' -or
        $config.serviceAccount -notmatch '^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$' -or
        $config.publisherId -notmatch '^[a-zA-Z0-9_-]+$' -or
        $config.googleAccount -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
        throw 'Invalid publishing configuration. Check release.local.json.'
    }
    $itemUrl = "https://chromewebstore.googleapis.com/v2/publishers/$($config.publisherId)/items/$itemId"
    $versionText = [string](Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json).version
    $version = Get-ReleaseVersion $versionText
    $zipPath = Join-Path $distPath "youtube-nano-chapters-$versionText.zip"

    if ($Command -ne 'status') {
        [IO.Directory]::CreateDirectory($distPath) | Out-Null
        try {
            $releaseLock = [IO.FileStream]::new((Join-Path $distPath 'store-release.lock'), [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose)
        } catch { throw "Could not acquire the release lock. Another release may be running. $($_.Exception.Message)" }
        & (Join-Path $PSScriptRoot 'package.ps1') | Out-Host
        if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { throw 'Release ZIP was not created.' }
    }
    if ($Command -ne 'status' -and -not $PSCmdlet.ShouldProcess("Chrome Web Store extension $itemId version $versionText", $Command)) {
        return
    }
    $tokenOutput = & gcloud auth print-access-token "--project=$($config.projectId)" "--account=$($config.googleAccount)" `
        "--impersonate-service-account=$($config.serviceAccount)" '--scopes=https://www.googleapis.com/auth/chromewebstore' --quiet --verbosity=error
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($tokenOutput -join ''))) {
        throw 'Could not obtain publishing credentials. Check gcloud sign-in and service account impersonation access.'
    }
    $headers = @{ Authorization = "Bearer $(($tokenOutput -join '').Trim())" }
    $status = Get-StoreStatus
    if ($Command -eq 'status') { Show-StoreStatus $status; return }
    Assert-StoreReady $status $version

    Write-Host "Uploading version $versionText..."
    $uploadUrl = "https://chromewebstore.googleapis.com/upload/v2/publishers/$($config.publisherId)/items/${itemId}:upload"
    try {
        $upload = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers -ContentType 'application/zip' -InFile $zipPath -TimeoutSec 120
    } catch { throw "Upload failed or its outcome is unknown. Check ./release.ps1 status before retrying. $($_.Exception.Message)" }
    if ((Get-Field $upload 'itemId') -ne $itemId) { throw 'Upload returned a different extension. Stopping.' }
    $uploadState = Get-Field $upload 'uploadState'
    $deadline = [DateTime]::UtcNow.AddSeconds(300)
    while ($uploadState -eq 'IN_PROGRESS') {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'Upload is still processing. Check ./release.ps1 status. Nothing was submitted.' }
        Start-Sleep -Seconds 2
        $status = Get-StoreStatus
        $uploadState = Get-Field $status 'lastAsyncUploadState'
    }
    if ($uploadState -ne 'SUCCEEDED') { throw "Upload state is '$uploadState'. Nothing was submitted." }
    $uploadedVersion = Get-Field $upload 'crxVersion'
    if ($uploadedVersion -and $uploadedVersion -ne $versionText) { throw 'Uploaded version does not match the package. Nothing was submitted.' }
    Write-Output "Uploaded version $versionText."
    try {
        $submission = Invoke-RestMethod -Method Post -Uri "${itemUrl}:publish" -Headers $headers -ContentType 'application/json' `
            -Body '{"publishType":"DEFAULT_PUBLISH","blockOnWarnings":true}' -TimeoutSec 60
    } catch { throw "Submission failed or its outcome is unknown. Check ./release.ps1 status before retrying. $($_.Exception.Message)" }
    if ((Get-Field $submission 'itemId') -ne $itemId) { throw 'Submission returned a different extension. Check store status.' }
    $state = Get-Field $submission 'state'
    if ($state -notin @('PENDING_REVIEW', 'PUBLISHED')) { throw "Unexpected submission state '$state'. Check ./release.ps1 status." }
    if ($state -eq 'PUBLISHED') { Write-Output "Version $versionText is published." }
    else { Write-Output "Version $versionText is pending review. Google will publish it after approval." }
} finally {
    if ($null -ne $releaseLock) { $releaseLock.Dispose() }
}
