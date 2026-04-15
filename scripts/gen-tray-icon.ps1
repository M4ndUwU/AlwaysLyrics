$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outPath = Join-Path $outDir 'tray.png'

Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 32, 32
$bmp.MakeTransparent()
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddEllipse(2, 2, 28, 28)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  [System.Drawing.Rectangle]::new(2, 2, 28, 28),
  [System.Drawing.Color]::FromArgb(255, 120, 200, 255),
  [System.Drawing.Color]::FromArgb(255, 55, 95, 200),
  [System.Drawing.Drawing2D.LinearGradientMode]::Vertical
)
$g.FillPath($brush, $path)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 255, 255, 255), 1.2)
$g.DrawPath($pen, $path)
$g.Dispose()
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "Wrote $outPath"
