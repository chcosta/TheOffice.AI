; NSIS installer hooks for TheOffice.AI (Tauri v2).
; PRE-install: stop a running instance so an in-place upgrade can overwrite locked
;   files (notably node\node.exe, held open by the Node sidecar). This is the
;   safety net for "Error opening file for writing" upgrade failures.
; POST-install: runs the bundled prerequisite installer (Git, Azure CLI, ripgrep
;   via winget). Non-fatal: a failure here never aborts the app install — the user
;   can re-run install-prerequisites.ps1 later.

!macro NSIS_HOOK_PREINSTALL
  ; The running app and its Node sidecar (plus any node.exe it spawned from the
  ; bundled runtime) hold $INSTDIR\node\node.exe open, which makes an in-place
  ; upgrade fail with "Error opening file for writing: node.exe". Stop them here,
  ; BEFORE any files are written, and give the OS a moment to release the handles.
  ; The desktop app also stops its own sidecar on exit, but a manually relaunched
  ; app (or an orphaned sidecar) would otherwise still lock the file.

  ; 1. Baseline: close the app AND its child tree (clean quoting; always safe).
  ;    /T kills the Node sidecar and its grandchildren since they descend from the
  ;    app process, covering the common case even on a first upgrade to this build.
  nsExec::Exec 'taskkill /F /T /IM "TheOffice.AI.exe"'
  Pop $R9

  ; 2. SELF-SUFFICIENT path-filtered cleanup. The old step here delegated to the
  ;    PREVIOUS install's stop-instances.ps1 — absent when upgrading FROM a build
  ;    that predates that script, which is exactly when the locked-file error bit.
  ;    Instead we write a tiny helper into the NSIS temp dir ($PLUGINSDIR, always
  ;    present, auto-cleaned) and run it. It kills ONLY node.exe / TheOffice.AI.exe
  ;    whose image lives under $INSTDIR (so unrelated Node processes are never
  ;    touched — e.g. Copilot CLI, the user's own node), then waits until they're
  ;    gone (up to ~20s) so the OS releases node.exe before files are overwritten.
  InitPluginsDir
  StrCpy $R0 "$PLUGINSDIR\stop-office-instances.ps1"
  FileOpen $R1 "$R0" w
  ${If} $R1 != ""
    FileWrite $R1 "param([string]$$InstallDir)$\r$\n"
    FileWrite $R1 "try { $$base = $$InstallDir.TrimEnd('\').ToLowerInvariant() } catch { $$base = $$InstallDir }$\r$\n"
    FileWrite $R1 "$$deadline = (Get-Date).AddSeconds(20)$\r$\n"
    FileWrite $R1 "do {$\r$\n"
    FileWrite $R1 "  $$procs = @(Get-CimInstance Win32_Process -Filter $\"Name='node.exe' OR Name='TheOffice.AI.exe'$\" -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.ToLowerInvariant().StartsWith($$base) })$\r$\n"
    FileWrite $R1 "  foreach ($$p in $$procs) { try { Stop-Process -Id $$p.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }$\r$\n"
    FileWrite $R1 "  if ($$procs.Count -gt 0) { Start-Sleep -Milliseconds 400 }$\r$\n"
    FileWrite $R1 "} while ($$procs.Count -gt 0 -and (Get-Date) -lt $$deadline)$\r$\n"
    FileClose $R1
    nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$R0" -InstallDir "$INSTDIR"'
    Pop $R9
  ${EndIf}

  ; 3. Small settle so any remaining image-file handles finish releasing.
  Sleep 700
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Skip prerequisite handling entirely on an in-place upgrade (/UPDATE). An
  ; upgrade must NEVER touch the user's existing tools (Git/az/Copilot/etc.).
  ${If} $UpdateMode <> 1
    ; Locate the bundled prereq script (resource layout can nest under \resources\).
    StrCpy $R0 "$INSTDIR\scripts\install-prerequisites.ps1"
    ${IfNot} ${FileExists} "$R0"
      StrCpy $R0 "$INSTDIR\resources\scripts\install-prerequisites.ps1"
    ${EndIf}

    ${If} ${FileExists} "$R0"
      ; First, check whether the REQUIRED prerequisites are already present.
      ; -CheckOnly installs nothing: exit 0 = all present, 10 = something missing.
      nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$R0" -CheckOnly -Quiet'
      Pop $R1  ; exit code (or "error"/"timeout" on failure to launch)

      ; Only prompt/install when a required prerequisite is actually missing.
      ; If everything is present ($R1 = 0) we skip silently and never upgrade
      ; anything. On an unknown result we fall through and let the user decide.
      ${If} $R1 == 0
        Goto prereqs_done
      ${EndIf}

      ${IfNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONQUESTION \
          "TheOffice.AI needs Git, the Azure CLI, and ripgrep, and some are missing.$\n$\nInstall the missing ones now via winget? (No admin required.)$\n$\nYou can also run this later from the install folder." \
          IDNO prereqs_done
      ${EndIf}

      ; Run per-user; ignore the result so a winget hiccup can't fail the install.
      ${If} ${Silent}
        nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$R0" -Quiet'
      ${Else}
        nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$R0"'
      ${EndIf}
      Pop $R1
      prereqs_done:
    ${EndIf}
  ${EndIf}
!macroend
