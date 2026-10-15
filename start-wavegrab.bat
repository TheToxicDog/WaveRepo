@echo off
cd /d "%~dp0"
if not exist .venv (
  echo First run: setting up WaveGrab...
  py -3 -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt pywebview
)
.venv\Scripts\python run.py %*
