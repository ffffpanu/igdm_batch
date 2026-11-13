@echo off
rem Merges  X_video.mp4 + X_audio.m4a  ->  X.mp4  for every pair in this folder and subfolders.
rem Requires ffmpeg in PATH. Run it from inside your Downloads\Instagram folder.
for /r %%F in (*_video.mp4) do call :merge "%%~dpnF"
echo Done.
pause
exit /b
:merge
set "BASE=%~1"
set "AUD=%BASE:_video=_audio%.m4a"
set "OUT=%BASE:_video=%.mp4"
if exist "%AUD%" ffmpeg -y -loglevel error -i "%BASE%.mp4" -i "%AUD%" -c copy "%OUT%" && echo Merged: %OUT%
exit /b
