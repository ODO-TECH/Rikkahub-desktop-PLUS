@echo off
setlocal
REM NOTE: keep this file ASCII-only with CRLF line endings (cmd.exe decodes .cmd
REM bytes in the console OEM codepage, so UTF-8 text and lone LF can break parsing).
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
set CARGO_TARGET_DIR=C:\rikkahub-build
cd /d "%~dp0"
REM Resolve cargo from rustup's home instead of hardcoding one machine's user profile.
if defined CARGO_HOME (call "%CARGO_HOME%\bin\cargo.exe" %*) else (call "%USERPROFILE%\.cargo\bin\cargo.exe" %*)
exit /b %errorlevel%
