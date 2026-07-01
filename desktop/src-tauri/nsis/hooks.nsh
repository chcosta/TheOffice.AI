; NSIS installer hooks for TheOffice.AI (Tauri v2).
; Runs the bundled prerequisite installer (Git, Azure CLI, ripgrep via winget)
; after the app files are laid down. Non-fatal: a failure here never aborts the
; app install — the user can re-run install-prerequisites.ps1 later.

!macro NSIS_HOOK_POSTINSTALL
  ; Locate the bundled prereq script (resource layout can nest under \resources\).
  StrCpy $R0 "$INSTDIR\scripts\install-prerequisites.ps1"
  ${IfNot} ${FileExists} "$R0"
    StrCpy $R0 "$INSTDIR\resources\scripts\install-prerequisites.ps1"
  ${EndIf}

  ${If} ${FileExists} "$R0"
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "TheOffice.AI needs Git, the Azure CLI, and ripgrep.$\n$\nInstall any that are missing now via winget? (No admin required.)$\n$\nYou can also run this later from the install folder." \
        IDNO skip_prereqs
    ${EndIf}

    ; Run per-user; ignore the result so a winget hiccup can't fail the install.
    ${If} ${Silent}
      nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$R0" -Quiet'
    ${Else}
      nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$R0"'
    ${EndIf}
    Pop $R1
    skip_prereqs:
  ${EndIf}
!macroend
