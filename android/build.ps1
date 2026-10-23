param(
  [ValidateSet('Development','Release')][string]$Configuration = 'Development',
  [string]$SdkRoot = $(if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $env:ANDROID_HOME }),
  [string]$JavaHome = $env:JAVA_HOME,
  [string]$ApplicationId = '',
  [string]$AppLabel = '',
  [string]$BuildDir = '',
  [string]$OutputApk = '',
  [string]$SigningDirectory = '',
  [string]$KeyAlias = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskDevelopment = $Configuration -eq 'Development'
$taskSourcePackage = 'app.relaydrop'
if ([string]::IsNullOrWhiteSpace($ApplicationId)) {
  if (-not $taskDevelopment) { throw 'Release requires an explicit -ApplicationId owned by the distributor.' }
  $ApplicationId = 'app.relaydrop.dev'
}
if ($ApplicationId -notmatch '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$') { throw 'ApplicationId must be a lower-case Android application ID.' }
if ($taskDevelopment -and $ApplicationId -eq $taskSourcePackage) { throw 'Development builds cannot use the existing production application ID.' }
if ([string]::IsNullOrWhiteSpace($AppLabel)) { $AppLabel = if ($taskDevelopment) { 'RelayDrop Dev' } else { 'RelayDrop' } }
if ([string]::IsNullOrWhiteSpace($BuildDir)) { $BuildDir = Join-Path $taskRoot '.build\android' }
if ([string]::IsNullOrWhiteSpace($OutputApk)) { $OutputApk = Join-Path $taskRoot $(if ($taskDevelopment) { 'dist\RelayDrop-Android-dev.apk' } else { 'dist\RelayDrop-Android-release.apk' }) }
if ([string]::IsNullOrWhiteSpace($SdkRoot)) { throw 'Set ANDROID_SDK_ROOT / ANDROID_HOME or pass -SdkRoot.' }
if ([string]::IsNullOrWhiteSpace($JavaHome)) { throw 'Set JAVA_HOME or pass -JavaHome (JDK 17 or newer).' }
$SdkRoot = [IO.Path]::GetFullPath($SdkRoot)
$JavaHome = [IO.Path]::GetFullPath($JavaHome)
$taskBuildTools = Join-Path $SdkRoot 'build-tools\35.0.0'
$taskPlatform = Join-Path $SdkRoot 'platforms\android-35\android.jar'
$taskJava = Join-Path $JavaHome 'bin\java.exe'
$taskJavac = Join-Path $JavaHome 'bin\javac.exe'
$taskJar = Join-Path $JavaHome 'bin\jar.exe'
$taskKeytool = Join-Path $JavaHome 'bin\keytool.exe'
$taskLibrary = Join-Path $PSScriptRoot 'lib\nanohttpd-2.3.1.jar'
$taskAapt = Join-Path $taskBuildTools 'aapt2.exe'
$taskZipalign = Join-Path $taskBuildTools 'zipalign.exe'
$taskSigner = Join-Path $taskBuildTools 'lib\apksigner.jar'
$taskD8 = Join-Path $taskBuildTools 'lib\d8.jar'
foreach ($taskRequired in @($taskPlatform,$taskJava,$taskJavac,$taskJar,$taskKeytool,$taskAapt,$taskZipalign,$taskSigner,$taskD8,$taskLibrary)) {
  if (-not (Test-Path -LiteralPath $taskRequired -PathType Leaf)) { throw ('Required build input is missing: ' + $taskRequired) }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $taskLibrary).Hash.ToLowerInvariant() -ne 'de864c47818157141a24c9acb36df0c47d7bf15b7ff48c90610f3eb4e5df0e58') {
  throw 'The vendored NanoHTTPD 2.3.1 checksum does not match. Restore the documented dependency before building.'
}

function Invoke-Checked {
  param([string]$Exe,[string[]]$ToolArgs)
  & $Exe @ToolArgs
  if ($LASTEXITCODE -ne 0) { throw ('Build command failed: ' + [IO.Path]::GetFileName($Exe)) }
}
function Assert-ExternalSigningFile {
  param([string]$File)
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw ('Required external signing file is missing: ' + [IO.Path]::GetFileName($File)) }
  if ((Get-Item -LiteralPath $File).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Signing files must not be links.' }
}

# Release keys are always an explicit input outside the checkout. No local-user
# signing path, signing environment variable, identity or certificate is inferred.
$taskKey = ''
$taskPassword = ''
$taskKeyPassword = ''
if (-not $taskDevelopment) {
  if ([string]::IsNullOrWhiteSpace($SigningDirectory) -or [string]::IsNullOrWhiteSpace($KeyAlias)) { throw 'Release requires -SigningDirectory and -KeyAlias.' }
  $taskSigning = [IO.Path]::GetFullPath($SigningDirectory)
  $taskRootPrefix = $taskRoot.TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
  if ($taskSigning.Equals($taskRoot,[StringComparison]::OrdinalIgnoreCase) -or $taskSigning.StartsWith($taskRootPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Release signing material must be outside this source checkout.' }
  if (-not (Test-Path -LiteralPath $taskSigning -PathType Container)) { throw 'SigningDirectory does not exist.' }
  if ((Get-Item -LiteralPath $taskSigning).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SigningDirectory must not be a link.' }
  $taskKey = Join-Path $taskSigning 'release.jks'
  $taskPassword = Join-Path $taskSigning 'store-password.txt'
  if (-not (Test-Path -LiteralPath $taskKey) -and -not (Test-Path -LiteralPath $taskPassword)) {
    $taskKey = Join-Path $taskSigning 'relaydrop.jks'
    $taskPassword = Join-Path $taskSigning 'password.txt'
  }
  $taskKeyPassword = Join-Path $taskSigning 'key-password.txt'
  Assert-ExternalSigningFile $taskKey
  Assert-ExternalSigningFile $taskPassword
  if (Test-Path -LiteralPath $taskKeyPassword) { Assert-ExternalSigningFile $taskKeyPassword } else { $taskKeyPassword = $taskPassword }
} elseif (-not [string]::IsNullOrWhiteSpace($SigningDirectory) -or -not [string]::IsNullOrWhiteSpace($KeyAlias)) {
  throw 'Development generates a temporary development key. Use Release with explicit inputs for a persistent signing key.'
}

# Every invocation starts in a fresh subdirectory. Stale classes and assets from
# earlier builds therefore cannot be packaged into this APK.
$taskBuild = Join-Path ([IO.Path]::GetFullPath($BuildDir)) ('build-' + [Guid]::NewGuid().ToString('N'))
$taskAssets = Join-Path $taskBuild 'assets'
$taskWeb = Join-Path $taskAssets 'web'
$taskGenerated = Join-Path $taskBuild 'generated'
$taskClasses = Join-Path $taskBuild 'classes'
$taskDex = Join-Path $taskBuild 'dex'
$taskDevSigning = Join-Path $taskBuild 'development-signing'
New-Item -ItemType Directory -Path $taskBuild,$taskAssets,$taskWeb,$taskGenerated,$taskClasses,$taskDex | Out-Null

try {
  # Keep the project's MIT notice and the shipped Android dependencies' notices.
  $taskLicenses = Join-Path $taskAssets 'licenses'
  New-Item -ItemType Directory -Path $taskLicenses | Out-Null
  foreach ($taskNotice in @('LICENSE','THIRD_PARTY_NOTICES.md')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot $taskNotice) -Destination $taskLicenses
  }
  Copy-Item -LiteralPath (Join-Path $taskRoot 'vendor\qr\LICENSE.txt') -Destination (Join-Path $taskLicenses 'QR-LICENSE.txt')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'lib\LICENSE-nanohttpd.md') -Destination $taskLicenses
  $taskPublicFiles = @('app.js','convenience.css','index.html','pool-convenience.js','pool-library.js','pool-navigation.js','pool.js','qr.js','sha256.js','styles.css')
  foreach ($taskAsset in $taskPublicFiles) { Copy-Item -LiteralPath (Join-Path $taskRoot ('public\' + $taskAsset)) -Destination $taskWeb }

  # Java classes keep their original namespace. Only the install/data identity
  # changes; fully qualified component names and --custom-package keep it valid.
  $taskManifest = New-Object Xml.XmlDocument
  $taskManifest.LoadXml((Get-Content -LiteralPath (Join-Path $PSScriptRoot 'AndroidManifest.xml') -Raw -Encoding UTF8))
  $taskNamespace = 'http://schemas.android.com/apk/res/android'
  $taskManifest.DocumentElement.SetAttribute('package',$ApplicationId)
  $taskApplication = $taskManifest.SelectSingleNode('/manifest/application')
  $taskApplication.SetAttribute('label',$taskNamespace,$AppLabel) | Out-Null
  $taskApplication.SetAttribute('debuggable',$taskNamespace,'false') | Out-Null
  $taskComponents = @($taskApplication) + @($taskManifest.SelectNodes('/manifest/application/activity | /manifest/application/activity-alias | /manifest/application/service | /manifest/application/receiver | /manifest/application/provider'))
  foreach ($taskComponent in $taskComponents) {
    foreach ($taskAttribute in @('name','targetActivity')) {
      $taskName = $taskComponent.GetAttribute($taskAttribute,$taskNamespace)
      if ($taskName.StartsWith('.')) { $taskComponent.SetAttribute($taskAttribute,$taskNamespace,($taskSourcePackage + $taskName)) | Out-Null }
      elseif ($taskName -and -not $taskName.Contains('.')) { $taskComponent.SetAttribute($taskAttribute,$taskNamespace,($taskSourcePackage + '.' + $taskName)) | Out-Null }
    }
  }
  $taskManifestPath = Join-Path $taskBuild 'AndroidManifest.xml'
  $taskXmlSettings = New-Object Xml.XmlWriterSettings
  $taskXmlSettings.Encoding = New-Object Text.UTF8Encoding($false)
  $taskXmlSettings.Indent = $true
  $taskXmlWriter = [Xml.XmlWriter]::Create($taskManifestPath,$taskXmlSettings)
  try { $taskManifest.Save($taskXmlWriter) } finally { $taskXmlWriter.Dispose() }

  $taskResources = Join-Path $taskBuild 'resources.zip'
  Invoke-Checked $taskAapt @('compile','--dir',(Join-Path $PSScriptRoot 'res'),'-o',$taskResources)
  $taskBase = Join-Path $taskBuild 'base.apk'
  Invoke-Checked $taskAapt @('link','-o',$taskBase,'-I',$taskPlatform,'--manifest',$taskManifestPath,'--custom-package',$taskSourcePackage,'--java',$taskGenerated,$taskResources)
  Invoke-Checked $taskJar @('uf',$taskBase,'-C',$taskBuild,'assets')
  $taskSources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src'),$taskGenerated -Recurse -File -Filter '*.java' | Select-Object -ExpandProperty FullName)
  $taskArgsFile = Join-Path $taskBuild 'javac-args.txt'
  $taskCompileArgs = @('--release','8','-encoding','UTF-8','-classpath',($taskPlatform + ';' + $taskLibrary),'-d',$taskClasses) + $taskSources
  $taskArgLines = @($taskCompileArgs | ForEach-Object { '"' + $_.Replace('\','/').Replace('"','\"') + '"' })
  [IO.File]::WriteAllLines($taskArgsFile,[string[]]$taskArgLines,(New-Object Text.UTF8Encoding($false)))
  Invoke-Checked $taskJavac @('@' + $taskArgsFile)
  $taskClassesJar = Join-Path $taskBuild 'classes.jar'
  Invoke-Checked $taskJar @('cf',$taskClassesJar,'-C',$taskClasses,'.')
  Invoke-Checked $taskJava @('-cp',$taskD8,'com.android.tools.r8.D8','--lib',$taskPlatform,'--min-api','26','--output',$taskDex,$taskClassesJar,$taskLibrary)
  foreach ($taskDexFile in @(Get-ChildItem -LiteralPath $taskDex -Filter '*.dex' -File)) { Invoke-Checked $taskJar @('uf',$taskBase,'-C',$taskDex,$taskDexFile.Name) }
  $taskAligned = Join-Path $taskBuild 'aligned.apk'
  Invoke-Checked $taskZipalign @('-f','4',$taskBase,$taskAligned)

  if ($taskDevelopment) {
    New-Item -ItemType Directory -Path $taskDevSigning | Out-Null
    $taskKey = Join-Path $taskDevSigning 'development.p12'
    $taskPassword = Join-Path $taskDevSigning 'password.txt'
    $taskKeyPassword = $taskPassword
    $KeyAlias = 'relaydrop-development'
    $taskRandomBytes = New-Object byte[] 32
    $taskRng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $taskRng.GetBytes($taskRandomBytes) } finally { $taskRng.Dispose() }
    [IO.File]::WriteAllText($taskPassword,[Convert]::ToBase64String($taskRandomBytes),(New-Object Text.UTF8Encoding($false)))
    Invoke-Checked $taskKeytool @('-genkeypair','-keystore',$taskKey,'-storetype','PKCS12','-storepass:file',$taskPassword,'-keypass:file',$taskPassword,'-alias',$KeyAlias,'-keyalg','RSA','-keysize','3072','-validity','3650','-dname','CN=RelayDrop Development','-noprompt')
  }
  $taskApk = [IO.Path]::GetFullPath($OutputApk)
  $taskApkParent = Split-Path -Parent $taskApk
  if (-not (Test-Path -LiteralPath $taskApkParent)) { New-Item -ItemType Directory -Path $taskApkParent | Out-Null }
  $taskSignArgs = @('-jar',$taskSigner,'sign','--ks',$taskKey,'--ks-key-alias',$KeyAlias,'--ks-pass',('file:' + $taskPassword))
  # apksigner consumes successive lines when a password file is repeated. Leave
  # --key-pass absent when both passwords match so it reuses the store password.
  if ($taskKeyPassword -ne $taskPassword) { $taskSignArgs += @('--key-pass',('file:' + $taskKeyPassword)) }
  $taskSignArgs += @('--out',$taskApk,$taskAligned)
  Invoke-Checked $taskJava $taskSignArgs
  Invoke-Checked $taskJava @('-jar',$taskSigner,'verify','--verbose',$taskApk)
  Invoke-Checked $taskZipalign @('-c','4',$taskApk)
  Write-Output ('Built ' + $ApplicationId + ' (' + $Configuration + ')')
  Get-FileHash -Algorithm SHA256 -LiteralPath $taskApk
} finally {
  # Only files created in this invocation's unique development-signing directory
  # are removed. Externally supplied release keys are never changed or deleted.
  if ($taskDevelopment -and (Test-Path -LiteralPath $taskDevSigning -PathType Container)) {
    foreach ($taskSecretName in @('development.p12','password.txt')) {
      $taskSecretFile = Join-Path $taskDevSigning $taskSecretName
      if (Test-Path -LiteralPath $taskSecretFile -PathType Leaf) { Remove-Item -LiteralPath $taskSecretFile -Force }
    }
    Remove-Item -LiteralPath $taskDevSigning -Force
  }
}
