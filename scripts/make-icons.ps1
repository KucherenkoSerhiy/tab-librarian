# Generates the Tab Librarian icon set (book spines on a shelf) at 16/48/128 px.
# Run: powershell -NoProfile -File scripts/make-icons.ps1
Add-Type -AssemblyName System.Drawing

function New-RoundRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$outDir = Join-Path $PSScriptRoot "..\public\icons"

foreach ($s in 16, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.ScaleTransform($s / 128, $s / 128)

  # rounded-square background, blue gradient
  $bgPath = New-RoundRectPath 0 0 128 128 28
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point(0, 128)),
    [System.Drawing.Color]::FromArgb(255, 59, 130, 246),
    [System.Drawing.Color]::FromArgb(255, 30, 64, 175))
  $g.FillPath($grad, $bgPath)

  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $lightBlue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 191, 219, 254))
  $shelfBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 255, 255, 255))

  # two upright book spines
  $g.FillPath($white, (New-RoundRectPath 26 38 20 56 4))
  $g.FillPath($lightBlue, (New-RoundRectPath 51 30 20 64 4))

  # one leaning book
  $state = $g.Save()
  $g.TranslateTransform(86, 94)
  $g.RotateTransform(12)
  $g.TranslateTransform(-86, -94)
  $g.FillPath($white, (New-RoundRectPath 76 36 20 58 4))
  $g.Restore($state)

  # shelf
  $g.FillPath($shelfBrush, (New-RoundRectPath 22 96 84 8 4))

  $g.Dispose()
  $bmp.Save((Join-Path $outDir "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "icon$s.png written"
}
