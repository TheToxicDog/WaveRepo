@echo off
cd /d "%~dp0"
if not exist .venv (
  echo First run: setting up WaveGrab...
  py -3 -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt pywebview
)
rem spotDL can fetch FFmpeg for us if it isn't installed
where ffmpeg >nul 2>nul
if errorlevel 1 if not exist "%USERPROFILE%\.spotdl\ffmpeg.exe" (
  echo Installing FFmpeg via spotDL...
  echo y| .venv\Scripts\python -m spotdl --download-ffmpeg
)
.venv\Scripts\python run.py %*
