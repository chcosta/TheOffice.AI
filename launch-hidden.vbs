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

objShell.Run strCmd, 0, False
