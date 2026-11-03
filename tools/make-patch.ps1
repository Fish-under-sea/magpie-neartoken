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

$work = Join-Path $root '.work\magpie-net'
if (-not (Test-Path $work)) { throw "找不到工作树：$work" }
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

# 本仓库的改动只有这两处：新包，与一条分派。
Copy-Item -Recurse (Join-Path $work 'internal\neartoken') (Join-Path $tmp 'internal\neartoken') -Force
Copy-Item (Join-Path $work 'internal\gui\pluginpagecall.go') (Join-Path $tmp 'internal\gui\pluginpagecall.go') -Force

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