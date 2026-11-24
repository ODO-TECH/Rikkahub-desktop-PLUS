@echo off
setlocal
REM Wrapper that activates MSVC + uses an ASCII target dir, then runs any tauri command.
REM Workarounds:
REM   1. cargo needs MSVC's link.exe; Git Bash's PATH otherwise resolves link to coreutils.
REM   2. CARGO_TARGET_DIR lives outside the project path (non-ASCII path breaks build scripts).
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"
)
if defined VSROOT set "VCVARS=%VSROOT%\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  echo Failed to locate vcvars64.bat. Install Visual Studio Build Tools 2022 with the C++ desktop workload.
  exit /b 1
)
call "%VCVARS%" > nul
if errorlevel 1 (
  echo Failed to activate MSVC build tools.
  exit /b 1
)
REM vcvars prepends MSVC paths; keep that order and make cargo reachable even when
REM CARGO_HOME is on another drive (this checkout pins it to D:).
if defined CARGO_HOME set "PATH=%CARGO_HOME%\bin;%PATH%"
set CARGO_TARGET_DIR=C:\rikkahub-build
cd /d "%~dp0\.."
bun run tauri %*
exit /b %errorlevel%
