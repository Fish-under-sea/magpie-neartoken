# 生成 patches\magpie-neartoken.patch：以「上游 v0.1.2732 + FISH 补丁」为基线，
# 把本仓库 host\ 下的改动叠上去，输出成 git 认的 a/ b/ 补丁。
#
# 用法：
#   pwsh -File tools\make-patch.ps1 -Upstream <纯上游目录> -FishPatch <fish.9.patch>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Upstream,
  [Parameter(Mandatory = $true)][string]$FishPatch,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path $root 'patches\magpie-neartoken.patch' }
New-Item -ItemType Directory -Force (Split-Path -Parent $Out) | Out-Null

$hostSrc = Join-Path $root 'host\internal'
if (-not (Test-Path $hostSrc)) { throw "找不到 host 源码：$hostSrc" }
if (-not (Test-Path $Upstream)) { throw "找不到上游源码：$Upstream" }
if (-not (Test-Path $FishPatch)) { throw "找不到 FISH 补丁：$FishPatch" }

$tmp = Join-Path $root '.work\patch-base'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Copy-Item -Recurse $Upstream $tmp

Push-Location $tmp
try {
  $env:HTTP_PROXY = ''; $env:HTTPS_PROXY = ''
  git init -q .
  git apply --whitespace=nowarn $FishPatch
  if ($LASTEXITCODE -ne 0) { throw 'FISH 补丁没打上' }
  git add -A
  git -c user.email=patch@local -c user.name=patch commit -q -m 'baseline: upstream + fish'
}
finally { Pop-Location }

# 本仓库的改动全在 host\internal 下，把它整树盖到基线上：host\ 就是补丁
# 的真源，加文件不必改这个脚本。
$hostSrc = Join-Path $root 'host\internal'
if (-not (Test-Path $hostSrc)) { throw "找不到 host 源码：$hostSrc" }
foreach ($item in Get-ChildItem $hostSrc) {
  Copy-Item -Recurse -Force $item.FullName (Join-Path $tmp 'internal')
}

Push-Location $tmp
try {
  git add -A
  git diff --cached --binary > $Out
  $count = (Select-String -Path $Out -Pattern '^diff --git ' -AllMatches).Matches.Count
  Write-Host "补丁：$Out"
  Write-Host "文件：$count 个"
}
finally {
  Pop-Location
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}