; NSIS installer hooks for TheOffice.AI (Tauri v2).
; Runs the bundled prerequisite installer (Git, Azure CLI, ripgrep via winget)
; after the app files are laid down. Non-fatal: a failure here never aborts the
; app install — the user can re-run install-prerequisites.ps1 later.

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
