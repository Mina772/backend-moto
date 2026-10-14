$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../evidence/release-closure/tools'))
New-Item -ItemType Directory -Force -Path $taskRoot | Out-Null
$taskUrl = 'https://fastdl.mongodb.org/tools/db/mongodb-database-tools-windows-x86_64-100.13.0.zip'
$taskZip = Join-Path $taskRoot 'mongodb-tools.zip'
Invoke-WebRequest -Uri $taskUrl -OutFile $taskZip -UseBasicParsing
$taskHash = Get-FileHash -LiteralPath $taskZip -Algorithm SHA256
@{ url=$taskUrl; sha256=$taskHash.Hash; bytes=(Get-Item -LiteralPath $taskZip).Length; transport='official HTTPS'; independentPublisherChecksumVerified=$false } | ConvertTo-Json | Set-Content (Join-Path $taskRoot 'download.json')
Expand-Archive -LiteralPath $taskZip -DestinationPath $taskRoot
Get-ChildItem -LiteralPath $taskRoot -Recurse -Filter mongodump.exe | Select-Object FullName
