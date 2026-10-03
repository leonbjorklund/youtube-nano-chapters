const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const itemId = "bbffbggibffkihciiafgjnmggomnbmme";
const publisherId = "test-publisher";
const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const storeStatus = (version = "1.1.0", submitted) => ({
  itemId,
  publishedItemRevisionStatus: {
    state: "PUBLISHED",
    distributionChannels: [{ crxVersion: version }],
  },
  ...(submitted ? { submittedItemRevisionStatus: { state: submitted } } : {}),
});

function runRelease(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nano-store-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, "release.ps1"), path.join(root, "release.ps1"));
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ version: "1.2.0" }));
  fs.writeFileSync(
    path.join(root, "release.local.json"),
    JSON.stringify({
      projectId: "test-store-project",
      serviceAccount: "publisher@test-store-project.iam.gserviceaccount.com",
      googleAccount: "owner@example.com",
      publisherId,
    }),
  );
  fs.mkdirSync(path.join(root, "dist"));
  const zip = path.join(root, "dist", "youtube-nano-chapters-1.2.0.zip");
  fs.writeFileSync(zip, "test archive");
  fs.writeFileSync(
    path.join(root, "package.ps1"),
    options.packageFailure
      ? "throw 'Mock package tests failed'"
      : "Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.log') 'package' -WhatIf:$false\n",
  );
  fs.writeFileSync(
    path.join(root, "responses.json"),
    JSON.stringify({
      statuses: options.statuses ?? [storeStatus()],
      upload: options.upload ?? { itemId, crxVersion: "1.2.0", uploadState: "SUCCEEDED" },
      submission: options.submission ?? { itemId, state: "PENDING_REVIEW" },
      authFailure: options.authFailure ?? false,
      uploadFailure: options.uploadFailure ?? false,
      submissionFailure: options.submissionFailure ?? false,
    }),
  );
  fs.writeFileSync(
    path.join(root, "run.ps1"),
    `
$ErrorActionPreference = 'Stop'
$global:responses = Get-Content -Raw (Join-Path $PSScriptRoot 'responses.json') | ConvertFrom-Json
$global:statusIndex = 0
function gcloud {
    Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.log') 'auth' -WhatIf:$false
    if ($global:responses.authFailure) { $global:LASTEXITCODE = 1; return }
    $global:LASTEXITCODE = 0
    return 'test-token'
}
function Start-Sleep { param($Seconds) }
function Invoke-RestMethod {
    param($Method, $Uri, $Headers, $TimeoutSec, $ContentType, $InFile, $Body)
    if ($Headers.Authorization -ne 'Bearer test-token') { throw 'Wrong authorization header' }
    if ($Uri -match ':fetchStatus$') {
        if ($Method -ne 'Get') { throw 'Wrong status method' }
        Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.log') 'status' -WhatIf:$false
        $index = [Math]::Min($global:statusIndex++, $global:responses.statuses.Count - 1)
        return $global:responses.statuses[$index]
    }
    if ($Method -ne 'Post') { throw 'Wrong mutation method' }
    if ($Uri -match '/upload/v2/.*:upload$') {
        Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.log') 'upload'
        if (-not (Test-Path -LiteralPath $InFile) -or $ContentType -ne 'application/zip') { throw 'Wrong archive upload' }
        if ($global:responses.uploadFailure) { throw 'Mock connection lost' }
        return $global:responses.upload
    }
    if ($Uri -match ':publish$') {
        Add-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.log') 'submit'
        if ($global:responses.submissionFailure) { throw 'Mock connection lost' }
        $request = $Body | ConvertFrom-Json
        if ($request.publishType -ne 'DEFAULT_PUBLISH' -or $request.blockOnWarnings -ne $true) { throw 'Wrong publication policy' }
        return $global:responses.submission
    }
    throw "Unexpected API request: $Uri"
}
& (Join-Path $PSScriptRoot 'release.ps1') @args
`,
  );
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(root, "run.ps1"),
    options.command ?? "publish",
  ];
  if (options.whatIf) args.push("-WhatIf");
  // Let Windows PowerShell locate its own modules when Node was launched from PowerShell 7.
  const env = { ...process.env };
  delete env.PSModulePath;
  const result = spawnSync(shell, args, { encoding: "utf8", timeout: 20_000, env });
  assert.ifError(result.error);
  const callsPath = path.join(root, "calls.log");
  const calls = fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, "utf8").trim().split(/\r?\n/)
    : [];
  assert.equal(fs.existsSync(path.join(root, "dist", "store-release.lock")), false);
  return { ...result, calls, output: result.stdout + result.stderr };
}

test("release packages before upload and reports pending review after submission", (t) => {
  const result = runRelease(t);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, ["package", "auth", "status", "upload", "submit"]);
  assert.match(result.output, /pending review/);
});

test("release waits for async upload success before submitting", (t) => {
  const result = runRelease(t, {
    upload: { itemId, uploadState: "IN_PROGRESS" },
    statuses: [
      storeStatus(),
      { ...storeStatus(), lastAsyncUploadState: "IN_PROGRESS" },
      { ...storeStatus(), lastAsyncUploadState: "SUCCEEDED" },
    ],
  });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, [
    "package",
    "auth",
    "status",
    "upload",
    "status",
    "status",
    "submit",
  ]);
});

test("release refuses an already published version and an existing review", (t) => {
  for (const status of [storeStatus("1.2.0"), storeStatus("1.1.0", "PENDING_REVIEW")]) {
    const result = runRelease(t, { statuses: [status] });
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(result.calls, ["package", "auth", "status"]);
  }
});

test("release cannot submit a failed or unrecognized upload", (t) => {
  for (const uploadState of ["FAILED", "unexpected"]) {
    const result = runRelease(t, { upload: { itemId, uploadState } });
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(result.calls, ["package", "auth", "status", "upload"]);
  }
});

test("release stops on failed build or failed authentication", (t) => {
  const build = runRelease(t, { packageFailure: true });
  assert.notEqual(build.status, 0, build.output);
  assert.deepEqual(build.calls, []);
  const auth = runRelease(t, { authFailure: true });
  assert.notEqual(auth.status, 0, auth.output);
  assert.deepEqual(auth.calls, ["package", "auth"]);
});

test("release dry run checks the package without authentication or store requests", (t) => {
  const result = runRelease(t, { whatIf: true });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, ["package"]);
});

test("release reports submission failures without claiming publication or retrying", (t) => {
  for (const options of [
    { submissionFailure: true },
    { submission: { itemId, state: "unexpected" } },
  ]) {
    const result = runRelease(t, options);
    assert.notEqual(result.status, 0, result.output);
    assert.deepEqual(result.calls, ["package", "auth", "status", "upload", "submit"]);
    assert.doesNotMatch(result.stdout, /pending review|is published/);
    assert.match(result.output, /Check .*release\.ps1 status/);
  }
});

test("release does not retry an upload with an unknown network outcome", (t) => {
  const result = runRelease(t, { uploadFailure: true });
  assert.notEqual(result.status, 0, result.output);
  assert.deepEqual(result.calls, ["package", "auth", "status", "upload"]);
  assert.match(result.output, /outcome is unknown/);
});

test("release status reads the store without packaging or mutation", (t) => {
  const result = runRelease(t, { command: "status" });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, ["auth", "status"]);
  assert.match(result.output, /Published: PUBLISHED 1\.1\.0/);
});
