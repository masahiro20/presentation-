@echo off
rem Photoreal perspectives with Blender (Cycles).
rem Usage: drag and drop the exported .glb file onto this file.
rem        The camera file (*.json) exported together must be in the same folder.
setlocal enabledelayedexpansion
chcp 65001 >nul
set "HERE=%~dp0"
set "GLB=%~1"
if "%GLB%"=="" (
  echo Drag and drop the exported .glb file onto this file.
  pause
  exit /b 1
)
set "BASE=%~dpn1"
set "JSON="
for %%F in ("%~dp1*.json") do set "JSON=%%~fF"
if "%JSON%"=="" (
  echo [ERROR] Camera file ^(.json^) was not found next to the .glb file.
  pause
  exit /b 1
)
set "BLENDER="
for /d %%D in ("%ProgramFiles%\Blender Foundation\Blender*") do if exist "%%D\blender.exe" set "BLENDER=%%D\blender.exe"
if "%BLENDER%"=="" (
  echo [ERROR] Blender was not found. Install Blender from https://www.blender.org/download/ and run again.
  pause
  exit /b 1
)
set "OUT=%~dp1perspectives"
echo Blender: %BLENDER%
echo Model  : %GLB%
echo Camera : %JSON%
echo Output : %OUT%
"%BLENDER%" -b --factory-startup -P "%HERE%render.py" -- --glb "%GLB%" --json "%JSON%" --shot all --out "%OUT%" --hdri "%HERE%..\..\public\hdri\kloofendal_48d_partly_cloudy_puresky_2k.hdr" --samples 256 --width 1920 --height 1080 --gpu
echo.
echo Done. Images are in: %OUT%
start "" "%OUT%"
pause
