Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' Determine script directory
strDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

' Find node.exe - use full path if available
strNode = "node"
If objFSO.FileExists("C:\Program Files\nodejs\node.exe") Then
    strNode = """C:\Program Files\nodejs\node.exe"""
End If

' Log file for troubleshooting
strLog = strDir & "\service.log"
strCmd = "cmd /c cd /d """ & strDir & """ && " & strNode & " server.js >> """ & strLog & """ 2>&1"

' Watchdog guard: this script is fired every few minutes by the scheduled task.
' Only launch the server if it is NOT already listening on its port, otherwise a
' redundant node process would load the whole app + DB, fail to bind the port
' (EADDRINUSE) and exit -- wasting resources and spamming the log on every tick.
' We keep the periodic schedule purely for crash recovery: if the server is down,
' the next tick brings it back up.
strPort = "3847"
strCheck = "powershell -NoProfile -NonInteractive -Command ""if (Get-NetTCPConnection -LocalPort " & strPort & " -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"""

' bWaitOnReturn = True so we get the real exit code. 0 = already running (skip),
' non-zero = not running (launch).
intAlive = objShell.Run(strCheck, 0, True)
If intAlive <> 0 Then
    objShell.Run strCmd, 0, False
End If
