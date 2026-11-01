@echo off
rem Ember's check-up in this console. Ember.exe is a windowed program: cmd.exe doesn't wait for one on its own, so
rem the report would come after the next prompt and its exit code (1 when a check fails) would be lost.
start "" /wait "%~dp0Ember.exe" --doctor
exit /b %errorlevel%
