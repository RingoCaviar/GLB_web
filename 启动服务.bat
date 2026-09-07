@echo off
chcp 936 >nul
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=5173"
set "PID_FILE=.glb-viewer.pid"
set "OUT_LOG=.glb-viewer-output.log"
set "ERR_LOG=.glb-viewer-error.log"
set "VITE_CLI=node_modules\vite\bin\vite.js"
set "START_HELPER=scripts\start-vite.mjs"
set "RESTART_HELPER=scripts\restart-vite.mjs"
set "LOCAL_RUNTIME=.runtime\node"
set "RUNTIME_MANAGER=scripts\manage-local-runtime.ps1"
set "NPM_CONFIG_CACHE=%CD%\.runtime\npm-cache"
set "NPM_CONFIG_UPDATE_NOTIFIER=false"
set "NPM_CONFIG_FUND=false"
set "NPM_CONFIG_AUDIT=false"

:menu
cls
echo ==================================================
echo              模型取景台 - 服务管理
echo ==================================================
echo.
echo   [1] 一键安装项目运行环境与依赖
echo   [2] 检查运行环境和依赖
echo   [3] 启动局域网服务
echo   [4] 查看服务状态
echo   [5] 停止局域网服务
echo   [6] 删除项目运行环境与依赖
echo   [7] 清理构建缓存和日志
echo   [8] 一键重启局域网服务
echo   [9] 构建静态部署包
echo   [10] 预处理环境贴图（1K/2K + 去色）
echo   [0] 退出
echo.
set "CHOICE="
set /p "CHOICE=请输入选项："
if not defined CHOICE goto end
if "%CHOICE%"=="1" goto install_environment
if "%CHOICE%"=="2" goto check_menu
if "%CHOICE%"=="3" goto start_service
if "%CHOICE%"=="4" goto show_status
if "%CHOICE%"=="5" goto stop_service
if "%CHOICE%"=="6" goto remove_environment
if "%CHOICE%"=="7" goto clean_runtime
if "%CHOICE%"=="8" goto restart_service
if "%CHOICE%"=="9" goto build_static_deployment
if "%CHOICE%"=="10" goto preprocess_environments
if "%CHOICE%"=="0" goto end
echo.
echo [错误] 无效选项，请重新输入。
pause
goto menu

:check_dependencies
set "CHECK_OK=1"
echo.
echo 正在检查运行环境...
call :resolve_runtime
if not defined NODE_CMD (
  echo [缺失] 未找到可用 Node.js。可选择菜单 [1] 安装到项目目录。
  set "CHECK_OK=0"
) else (
  for /f "delims=" %%V in ('"!NODE_CMD!" --version 2^>nul') do echo [正常] !RUNTIME_SOURCE! Node.js %%V
  for /f "delims=" %%V in ('call "!NPM_CMD!" --version 2^>nul') do echo [正常] npm %%V
)

if not exist "package.json" (
  echo [缺失] 当前目录中没有 package.json。
  set "CHECK_OK=0"
) else (
  echo [正常] 已找到项目配置文件。
)

set "GLB_FILE="
for /f "delims=" %%G in ('dir /b /s /a-d "models\*.glb" 2^>nul') do if not defined GLB_FILE set "GLB_FILE=%%G"
if not defined GLB_FILE (
  echo [项目内容] models 目录中未找到 GLB 模型；这不属于运行环境缺失。
) else (
  echo [项目内容] 已找到 GLB 模型：!GLB_FILE!
)

if "!CHECK_OK!"=="1" (
  if not exist "node_modules\@google\model-viewer\package.json" (
    echo [缺失] 项目依赖尚未安装。
    set "CHECK_OK=0"
  ) else if not exist "node_modules\vite\package.json" (
    echo [缺失] Vite 依赖尚未安装。
    set "CHECK_OK=0"
  ) else (
    call "!NPM_CMD!" list --depth=0 >nul 2>nul
    if errorlevel 1 (
      echo [异常] 项目依赖不完整或版本不匹配。
      set "CHECK_OK=0"
    ) else (
      echo [正常] 项目依赖完整。
    )
  )
)

if "!CHECK_OK!"=="1" (
  echo.
  echo [结果] 所有运行依赖均已就绪。
) else (
  echo.
  echo [结果] 运行环境不完整。
)
exit /b

:check_menu
call :check_dependencies
if "!CHECK_OK!"=="0" (
  call :resolve_runtime
  if defined NPM_CMD if exist "package.json" (
    echo.
    set /p "INSTALL_NOW=是否现在执行 npm install 修复依赖？[Y/N]："
    if /i "!INSTALL_NOW!"=="Y" (
      echo.
      echo 正在安装依赖，请稍候...
      call "!NPM_CMD!" install
      if errorlevel 1 (
        echo [失败] 依赖安装失败，请检查上方错误信息。
      ) else (
        echo [完成] 依赖安装成功。
      )
    )
  )
)
echo.
pause
goto menu

:resolve_runtime
set "NODE_CMD="
set "NPM_CMD="
set "RUNTIME_SOURCE="
if exist "%LOCAL_RUNTIME%\node.exe" if exist "%LOCAL_RUNTIME%\npm.cmd" (
  set "NODE_CMD=%CD%\%LOCAL_RUNTIME%\node.exe"
  set "NPM_CMD=%CD%\%LOCAL_RUNTIME%\npm.cmd"
  set "RUNTIME_SOURCE=项目内"
  exit /b
)
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_CMD set "NODE_CMD=%%N"
for /f "delims=" %%N in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%N"
if defined NODE_CMD if defined NPM_CMD set "RUNTIME_SOURCE=系统"
exit /b

:install_environment
echo.
echo ==================================================
echo              安装项目专属运行环境
echo ==================================================
echo Node.js、npm 缓存和依赖都会放在当前项目目录内。
echo 不修改系统 PATH，不影响其他项目，也不需要管理员权限。
echo.
if not exist "%RUNTIME_MANAGER%" (
  echo [失败] 缺少运行环境安装程序：%RUNTIME_MANAGER%
  pause
  goto menu
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%RUNTIME_MANAGER%" -Action Install -ProjectRoot "%CD%"
if errorlevel 1 (
  echo.
  echo [失败] 项目内 Node.js 安装失败，请检查网络或上方错误。
  pause
  goto menu
)
call :resolve_runtime
if not defined NPM_CMD (
  echo [失败] 无法使用刚安装的项目内 npm。
  pause
  goto menu
)
echo.
echo 正在把网页依赖安装到项目 node_modules，请稍候……
call "!NPM_CMD!" install
if errorlevel 1 (
  echo [失败] npm 依赖安装失败，请检查上方错误。
) else (
  echo [完成] 项目运行环境和依赖均已就绪，可以直接启动服务。
)
echo.
pause
goto menu

:get_listener
set "LISTENER_PID="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":%PORT% .*LISTENING"') do if not defined LISTENER_PID set "LISTENER_PID=%%P"
exit /b

:quick_check
set "QUICK_OK=1"
call :resolve_runtime
if not defined NODE_CMD set "QUICK_OK=0"
if not defined NPM_CMD set "QUICK_OK=0"
if not exist "package.json" set "QUICK_OK=0"
if not exist "node_modules\@google\model-viewer\package.json" set "QUICK_OK=0"
if not exist "node_modules\vite\package.json" set "QUICK_OK=0"
if not exist "%VITE_CLI%" set "QUICK_OK=0"
if not exist "%START_HELPER%" set "QUICK_OK=0"
if not exist "%RESTART_HELPER%" set "QUICK_OK=0"
exit /b

:start_service
call :get_listener
if defined LISTENER_PID (
  echo.
  set "RECORDED_PID="
  if exist "%PID_FILE%" set /p RECORDED_PID=<"%PID_FILE%"
  if "!RECORDED_PID!"=="!LISTENER_PID!" (
    echo [提示] 本项目服务已经运行，进程 PID：!LISTENER_PID!
    call :print_addresses
  ) else (
    echo [停止] 端口 %PORT% 已被其他进程占用，进程 PID：!LISTENER_PID!
  )
  echo.
  pause
  goto menu
)

call :quick_check
if "!QUICK_OK!"=="0" (
  echo.
  echo [停止] 缺少必要运行文件，请先选择“检查运行依赖”并修复。
  echo.
  pause
  goto menu
)

echo.
echo 正在启动服务...
if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul
start "" /b "!NODE_CMD!" "%START_HELPER%" "%PORT%" "%OUT_LOG%" "%ERR_LOG%" "%PID_FILE%" >nul 2>nul
powershell -NoProfile -Command "$end=[DateTime]::UtcNow.AddSeconds(2); while(-not (Test-Path '%CD%\%PID_FILE%')) { if([DateTime]::UtcNow -ge $end) { exit 1 }; Start-Sleep -Milliseconds 40 }"
if errorlevel 1 (
  echo [失败] 无法创建服务进程。
  echo.
  pause
  goto menu
)
if exist "%PID_FILE%" set /p SERVICE_PID=<"%PID_FILE%"
if not defined SERVICE_PID (
  echo [失败] 无法创建服务进程。
  echo.
  pause
  goto menu
)
>"%PID_FILE%" echo !SERVICE_PID!

powershell -NoProfile -Command "$pidToWatch=%SERVICE_PID%; $end=[DateTime]::UtcNow.AddSeconds(5); do { if (-not (Get-Process -Id $pidToWatch -ErrorAction SilentlyContinue)) { exit 2 }; $c=New-Object Net.Sockets.TcpClient; try {$c.Connect('127.0.0.1',%PORT%); $c.Close(); exit 0} catch {$c.Dispose(); Start-Sleep -Milliseconds 80} } while([DateTime]::UtcNow -lt $end); exit 1"
if not errorlevel 1 (
  call :get_listener
  if "!LISTENER_PID!"=="!SERVICE_PID!" goto service_started
)

echo [失败] 服务未能在端口 %PORT% 启动。
if exist "%ERR_LOG%" type "%ERR_LOG%"
taskkill /PID !SERVICE_PID! /T /F >nul 2>nul
if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul
echo.
pause
goto menu

:remove_environment
echo.
echo ==================================================
echo              删除项目运行环境与依赖
echo ==================================================
echo 将删除当前项目内的：
echo   - .runtime 项目专属 Node.js 和 npm 缓存
echo   - node_modules 网页依赖
echo   - dist、.vite、服务 PID 与日志
echo.
echo 不会卸载系统 Node.js，也不会碰其他文件夹。
echo models、源码、配置、文档和 Git 数据都会保留。
echo.
set "REMOVE_CONFIRM="
set /p "REMOVE_CONFIRM=确认删除请输入 REMOVE，其他内容取消："
if /i not "!REMOVE_CONFIRM!"=="REMOVE" (
  echo [取消] 未删除任何内容。
  pause
  goto menu
)
call :stop_recorded_for_cleanup
if "!CLEAN_STOP_OK!"=="0" (
  pause
  goto menu
)
if exist "node_modules" rmdir /s /q "node_modules"
if exist "dist" rmdir /s /q "dist"
if exist ".vite" rmdir /s /q ".vite"
if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul
if exist "%OUT_LOG%" del /q "%OUT_LOG%" >nul 2>nul
if exist "%ERR_LOG%" del /q "%ERR_LOG%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%RUNTIME_MANAGER%" -Action Remove -ProjectRoot "%CD%"
if exist ".runtime" (
  echo [警告] 项目运行环境未能完全删除，请关闭占用文件的程序后重试。
) else if exist "node_modules" (
  echo [警告] 项目依赖未能完全删除，请关闭占用文件的程序后重试。
) else (
  echo [完成] 项目专属运行环境与依赖已经删除。
)
echo.
pause
goto menu

:stop_recorded_for_cleanup
set "CLEAN_STOP_OK=1"
call :get_listener
if not defined LISTENER_PID exit /b
set "RECORDED_PID="
if exist "%PID_FILE%" set /p RECORDED_PID=<"%PID_FILE%"
if not "!RECORDED_PID!"=="!LISTENER_PID!" (
  echo [停止] 端口 %PORT% 由其他程序占用，为避免误停，本次操作取消。
  set "CLEAN_STOP_OK=0"
  exit /b
)
echo 正在停止本项目服务 PID：!LISTENER_PID! ...
taskkill /PID !LISTENER_PID! /T /F >nul 2>nul
powershell -NoProfile -Command "$end=[DateTime]::UtcNow.AddSeconds(3); while(Get-Process -Id !LISTENER_PID! -ErrorAction SilentlyContinue) { if([DateTime]::UtcNow -ge $end) { exit 1 }; Start-Sleep -Milliseconds 80 }"
if errorlevel 1 (
  echo [失败] 项目服务未能停止，未执行删除。
  set "CLEAN_STOP_OK=0"
)
exit /b

:service_started
echo [成功] 局域网服务已经启动。
call :print_addresses
echo.
echo 日志文件：%OUT_LOG% 和 %ERR_LOG%
echo.
pause
goto menu

:print_addresses
echo.
echo 本机地址：http://localhost:%PORT%/
for /f "tokens=4" %%A in ('route print -4 0.0.0.0 ^| findstr /R "^[ ]*0\.0\.0\.0[ ]*0\.0\.0\.0"') do echo 局域网地址：http://%%A:%PORT%/
exit /b

:show_status
call :get_listener
echo.
if defined LISTENER_PID (
  set "RECORDED_PID="
  if exist "%PID_FILE%" set /p RECORDED_PID=<"%PID_FILE%"
  if "!RECORDED_PID!"=="!LISTENER_PID!" (
    echo [运行中] 本项目服务正在监听端口 %PORT%，进程 PID：!LISTENER_PID!
    call :print_addresses
  ) else (
    echo [端口占用] 端口 %PORT% 正由其他进程监听，进程 PID：!LISTENER_PID!
  )
) else (
  echo [未运行] 当前没有服务监听端口 %PORT%。
  if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul
)
echo.
pause
goto menu

:stop_service
call :get_listener
if not defined LISTENER_PID (
  echo.
  echo [提示] 服务当前没有运行。
  if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul
  echo.
  pause
  goto menu
)

set "TARGET_PID="
if exist "%PID_FILE%" set /p TARGET_PID=<"%PID_FILE%"
if not "!TARGET_PID!"=="!LISTENER_PID!" (
  echo.
  echo [注意] 当前监听进程不是由本脚本记录的项目服务。
  echo 当前占用端口 %PORT% 的进程 PID：!LISTENER_PID!
  set /p "FORCE_STOP=是否仍要停止该端口上的进程？[Y/N]："
  if /i not "!FORCE_STOP!"=="Y" goto menu
  set "TARGET_PID=!LISTENER_PID!"
)

echo.
echo 正在停止服务 PID：!TARGET_PID! ...
taskkill /PID !TARGET_PID! /T /F >nul 2>nul
call :get_listener
if defined LISTENER_PID (
  if not "!LISTENER_PID!"=="!TARGET_PID!" (
    taskkill /PID !LISTENER_PID! /T /F >nul 2>nul
    call :get_listener
  )
)
if defined LISTENER_PID (
  echo [失败] 端口 %PORT% 仍被进程 !LISTENER_PID! 占用。
) else (
  echo [成功] 服务已经停止。
  if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul
)
echo.
pause
goto menu

:restart_service
call :quick_check
if "!QUICK_OK!"=="0" (
  echo.
  echo [停止] 缺少必要运行文件，请先选择“检查运行环境和依赖”进行修复。
  echo.
  pause
  goto menu
)

echo.
echo ==================================================
echo                  一键重启服务
echo ==================================================
"!NODE_CMD!" "%RESTART_HELPER%" "%PORT%" "%OUT_LOG%" "%ERR_LOG%" "%PID_FILE%"
if errorlevel 1 (
  echo.
  echo [失败] 服务重启失败，请查看上方提示或 %ERR_LOG%。
) else (
  echo.
  echo [成功] 局域网服务已经完成重启。
)
echo.
pause
goto menu

:build_static_deployment
call :quick_check
if "!QUICK_OK!"=="0" (
  echo.
  echo [停止] 缺少必要项目文件或依赖，请先安装项目环境。
  echo.
  pause
  goto menu
)

echo.
echo 正在构建静态部署包...
call "!NPM_CMD!" run build
if errorlevel 1 (
  echo [失败] 静态部署包构建失败，请查看上方输出。
) else (
  echo [完成] 静态部署包已生成到 dist 文件夹。
  echo [提示] 将整个 dist 文件夹复制到目标电脑后，双击其中的 启动静态服务.bat 即可。
  echo [位置] %CD%\dist
  start "" explorer "%CD%\dist"
)
echo.
echo 3 秒后返回菜单...
timeout /t 3 /nobreak >nul
goto menu
:preprocess_environments
call :quick_check
if "!QUICK_OK!"=="0" (
  echo.
  echo [停止] 缺少必要项目文件或依赖，请先安装项目环境。
  echo.
  pause
  goto menu
)

echo.
echo 此操作会处理 public\environments 中所有 HDR 与 EXR 文件：
echo   - 彩色环境贴图缩放为 1K 或 2K
echo   - 自动生成对应的 1K 去色 HDR
echo   - EXR 原件转换成功后会被删除，避免重复占用空间
echo.
set "ENV_SIZE="
set /p "ENV_SIZE=请输入彩色 HDRI 宽度 [1=1K, 2=2K]："
if "!ENV_SIZE!"=="1" set "ENV_WIDTH=1024"
if "!ENV_SIZE!"=="2" set "ENV_WIDTH=2048"
if not defined ENV_WIDTH (
  echo [取消] 请输入 1 或 2。
  pause
  goto menu
)
set "ENV_CONFIRM="
set /p "ENV_CONFIRM=确认处理并删除 EXR 原件？请输入 PROCESS："
if /i not "!ENV_CONFIRM!"=="PROCESS" (
  echo [取消] 未修改环境贴图。
  pause
  goto menu
)
echo.
echo 正在预处理环境贴图...
"!NODE_CMD!" scripts\preprocess-environments.mjs --size !ENV_WIDTH!
if errorlevel 1 (
  echo [失败] 环境贴图预处理失败，请查看上方信息。
) else (
  echo [完成] 环境贴图预处理完成。重启服务或执行构建后即可生效。
)
echo.
pause
goto menu
:clean_runtime
echo.
echo ==================================================
echo                  清理运行环境
echo ==================================================
echo 将永久删除以下可重新生成的内容：
echo   - dist 生产构建目录
echo   - .vite 临时缓存目录
echo   - 服务 PID 与输出、错误日志
echo.
echo [保留] models 中的全部模型、贴图和缩略图不会删除。
echo [保留] 项目源码、配置、文档和 Git 数据不会删除。
echo [保留] 项目内 Node.js、npm 缓存和 node_modules 依赖不会删除。
echo.
set "CLEAN_CONFIRM="
set /p "CLEAN_CONFIRM=确认清理请输入 CLEAN，其他内容取消："
if /i not "!CLEAN_CONFIRM!"=="CLEAN" (
  echo.
  echo [取消] 未执行任何删除操作。
  echo.
  pause
  goto menu
)

call :stop_recorded_for_cleanup
if "!CLEAN_STOP_OK!"=="0" (
  echo.
  pause
  goto menu
)

echo.
echo 正在清理可重新生成的运行文件...
if exist "dist" rmdir /s /q "dist"
if exist ".vite" rmdir /s /q ".vite"
if exist "%PID_FILE%" del /q "%PID_FILE%" >nul 2>nul
if exist "%OUT_LOG%" del /q "%OUT_LOG%" >nul 2>nul
if exist "%ERR_LOG%" del /q "%ERR_LOG%" >nul 2>nul

set "CLEAN_FAILED=0"
if exist "dist" set "CLEAN_FAILED=1"
if exist ".vite" set "CLEAN_FAILED=1"
if exist "%PID_FILE%" set "CLEAN_FAILED=1"
if exist "%OUT_LOG%" set "CLEAN_FAILED=1"
if exist "%ERR_LOG%" set "CLEAN_FAILED=1"
if "!CLEAN_FAILED!"=="1" (
  echo [警告] 部分运行文件未能删除，请关闭占用文件的程序后重试。
) else (
  echo [完成] 构建缓存和日志已经清理，运行环境与项目文件保持不变。
)
echo.
pause
goto menu

:end
endlocal
exit /b 0
