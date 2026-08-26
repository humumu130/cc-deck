' CC Relay hidden autostart entry.
' Called by the startup shortcut created by install-autostart.ps1:
'   target = wscript.exe "<repo>\relay\scripts\start-relay.vbs"
Dim fso, sh, bat
Set fso = CreateObject("Scripting.FileSystemObject")
bat = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "start-relay.bat")
Set sh = CreateObject("WScript.Shell")
sh.Run """" & bat & """", 0, False
