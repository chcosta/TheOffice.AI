Set objShell = CreateObject("WScript.Shell")
objShell.Run "cmd /c cd /d """ & Replace(WScript.ScriptFullName, "\launch-hidden.vbs", "") & """ && node server.js", 0, False
