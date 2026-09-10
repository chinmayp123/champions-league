# One-time move of this project from worldcup-tracker to champions-league. Run from a FRESH
# PowerShell window (any open terminal or editor sitting inside the folder blocks the rename):
#   powershell -ExecutionPolicy Bypass -File "C:\Users\chinm\Personal-Projects\worldcup-tracker\rename-folder.ps1"
# It quits the widget, renames the folder, recreates the desktop shortcut, repoints the
# morning scheduled task, relaunches the widget, then deletes itself.
$old = "C:\Users\chinm\Personal-Projects\worldcup-tracker"
$new = "C:\Users\chinm\Personal-Projects\champions-league"
Set-Location $env:USERPROFILE
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'worldcup-tracker' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
Rename-Item -LiteralPath $old -NewName "champions-league" -ErrorAction Stop
Write-Host "folder renamed"
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$desktop\Starball Lab.lnk")
$lnk.TargetPath = "$new\node_modules\electron\dist\electron.exe"
$lnk.Arguments = "`"$new\widget\main.cjs`""
$lnk.WorkingDirectory = $new
$lnk.IconLocation = "$new\widget\icon.ico,0"
$lnk.Description = "Starball Lab — Champions League widget"
$lnk.Save()
Write-Host "desktop shortcut recreated"
schtasks /Change /TN "WorldCup Morning Parlays" /TR "wscript.exe `"$new\run-morning.vbs`"" | Out-Null
Write-Host "morning task repointed"
Start-Process -FilePath "$new\node_modules\electron\dist\electron.exe" -ArgumentList "`"$new\widget\main.cjs`"" -WorkingDirectory $new
Write-Host "widget launched from the new folder"
Remove-Item -LiteralPath "$new\rename-folder.ps1" -Force
