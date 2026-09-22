; electron-builder 26.15.3 restores the previous InstallLocation, but its
; assisted-installer instFilesPre then appends the renamed APP_FILENAME.
; Keep that exact existing directory for upgrades. Fresh installations and
; explicitly changed directories still use the original directory validation.
;
; Hook order: custom include -> assistedInstaller defines instFilesPre -> this
; hook -> MUI_PAGE_INSTFILES captures its PRE callback -> .onInit restores the
; GUID's install mode/path -> selected directory -> PRE -> old uninstall/install.
!macro customPageAfterChangeDir
  !ifdef allowToChangeInstallationDirectory
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
    !define MUI_PAGE_CUSTOMFUNCTION_PRE pairleafInstFilesPre

    Function pairleafInstFilesPre
      Push $R0
      ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $R0 != ""
      ${AndIf} $INSTDIR == $R0
        Pop $R0
        Return
      ${EndIf}
      Pop $R0
      ClearErrors
      Call instFilesPre
    FunctionEnd
  !endif
!macroend
