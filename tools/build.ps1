# 从一棵 magpie 源码树里发出 dist\magpie-<版本>.exe。
#
# 前提：那棵树已经叠好 FISH 的补丁与本仓库的补丁（见 README 的「从源码构建」）。
# 工具链路径默认从本仓库的 .work\magpie-build\tools\go 找，可以用 -GoRoot 指别处。
[CmdletBinding()]
param(
  [string]$Upstream = '',
  [string]$GoRoot = '',
  [string]$VersionTag = 'v0.1.2732+fish.9+neartoken.1',
  [string]$FileVersion = '0.1.2732.9',
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $Upstream) { $Upstream = Join-Path $root '.work\magpie-net' }
if (-not (Test-Path $Upstream)) { throw "找不到 magpie 源码树：$Upstream（用 -Upstream 指定）" }
$Upstream = (Resolve-Path $Upstream).Path

if (-not $GoRoot) {
  $candidates = @(
    (Join-Path $root '.work\magpie-build\tools\go'),
    (Join-Path $root '..\..\FISH-Dock-1103\.work\toolchain\go')
  )
  $GoRoot = $candidates | Where-Object { Test-Path (Join-Path $_ 'bin\go.exe') } | Select-Object -First 1
}
if (-not $GoRoot -or -not (Test-Path (Join-Path $GoRoot 'bin\go.exe'))) {
  throw '找不到 Go 工具链：用 -GoRoot 指向 go 的安装目录（含 bin\go.exe）'
}

$build = Join-Path $root '.work\magpie-build'
$env:GOROOT = $GoRoot
$env:PATH = "$GoRoot\bin;$env:PATH"
$env:GOPATH = Join-Path $build 'gopath'
$env:GOCACHE = Join-Path $build 'gocache'
$env:GOTMPDIR = Join-Path $build 'gotmp'
$env:GOMODCACHE = Join-Path $build 'gomod'
$env:GOPROXY = 'https://goproxy.cn,direct'
$env:GOTOOLCHAIN = 'local'
$env:CGO_ENABLED = '0'
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
New-Item -ItemType Directory -Force $env:GOPATH, $env:GOCACHE, $env:GOTMPDIR, $env:GOMODCACHE | Out-Null

if (-not $Out) { $Out = Join-Path $build 'dist\magpie-neartoken.exe' }
New-Item -ItemType Directory -Force (Split-Path -Parent $Out) | Out-Null

Push-Location $Upstream
try {
  Write-Host '== 1/3 版本资源'
  & go run github.com/tc-hib/go-winres@v0.3.3 make --in build/windows/fish-winres.json --arch amd64 --out rsrc `
    --file-version "$FileVersion" --product-version "$FileVersion"
  if ($LASTEXITCODE -ne 0) { throw "winres 失败（exit $LASTEXITCODE）" }

  Write-Host '== 2/3 launcher'
  & go build -trimpath -ldflags '-s -w' -o internal/update/launcher-amd64.com ./internal/update/launcher
  if ($LASTEXITCODE -ne 0) { throw "launcher 构建失败（exit $LASTEXITCODE）" }

  Write-Host '== 3/3 主程序'
  & go build -tags 'production,comlauncher' -trimpath `
    -ldflags "-s -w -X main.version=$VersionTag -H windowsgui" -o $Out .
  if ($LASTEXITCODE -ne 0) { throw "主程序构建失败（exit $LASTEXITCODE）" }
}
finally {
  Remove-Item (Join-Path $Upstream 'rsrc_windows_*.syso') -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $Upstream 'internal/update/launcher-*.com') -Force -ErrorAction SilentlyContinue
  Pop-Location
}

$item = Get-Item $Out
$hash = (Get-FileHash $Out -Algorithm SHA256).Hash.ToLower()
Write-Host ''
Write-Host "BUILT  : $($item.FullName)"
Write-Host "BYTES  : $($item.Length)"
Write-Host "SHA256 : $hash"
Write-Host "VER    : $VersionTag"