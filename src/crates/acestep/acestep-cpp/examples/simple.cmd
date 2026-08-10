@echo off

set PATH=%~dp0..\build\Release;%PATH%

ace-lm.exe ^
    --models ..\models ^
    --request simple.json

ace-synth.exe ^
    --models ..\models ^
    --request simple0.json

pause
