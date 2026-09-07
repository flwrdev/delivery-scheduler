<#
.SYNOPSIS
  Ipinapakita ang window ng automation browser (Chrome for Testing) na pinapatakbo
  ng chrome-devtools / playwright MCP.

.DESCRIPTION
  Minsan nabubuo ang window ng MCP-launched na Chrome sa hidden state
  (IsWindowVisible = False), kaya mukhang headless kahit hindi naman. Hinahanap
  ng script na ito ang mga window ng Chrome for Testing, ipinapakita, nire-restore,
  inilalagay sa nakikitang posisyon, at dinadala sa harap.

.EXAMPLE
  pwsh -File scripts/show-automation-browser.ps1
#>

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WinApi {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r);
}
'@

$targets = New-Object System.Collections.ArrayList
$callback = [WinApi+EnumWindowsProc] {
    param($hwnd, $lparam)
    $sb = New-Object System.Text.StringBuilder 512
    [WinApi]::GetWindowText($hwnd, $sb, 512) | Out-Null
    $title = $sb.ToString()
    if ($title -like '*Chrome for Testing*') {
        [void]$targets.Add([pscustomobject]@{ Handle = $hwnd; Title = $title })
    }
    return $true
}
[WinApi]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

if ($targets.Count -eq 0) {
    Write-Host 'Walang nahanap na Chrome for Testing window. Hindi pa siguro naka-launch ang MCP browser - gumamit muna ng browser tool para mag-launch ito.'
    exit 1
}

foreach ($t in $targets) {
    [WinApi]::ShowWindow($t.Handle, 5) | Out-Null   # SW_SHOW
    [WinApi]::ShowWindow($t.Handle, 9) | Out-Null   # SW_RESTORE
    [WinApi]::MoveWindow($t.Handle, 40, 40, 1456, 1000, $true) | Out-Null
    [WinApi]::SetForegroundWindow($t.Handle) | Out-Null
    $vis = [WinApi]::IsWindowVisible($t.Handle)
    Write-Host "Ipinakita: '$($t.Title)' (visible = $vis)"
}
