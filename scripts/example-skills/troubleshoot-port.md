---
name: 排查端口占用
description: 本机 Node 服务端口被占用的标准排查流程
triggers: 端口占用, EADDRINUSE, 端口被占, 起不来
---

# 排查端口占用（EADDRINUSE）

本仓库常踩的坑：后台进程孤儿占着端口，表现为「服务起不来」或「数据翻倍」。

## 排查步骤

1. **确认是哪个进程占着**（Windows / Git Bash）：
   `netstat -ano | grep ":3000" | grep LISTENING`
   最后一列是 PID。
2. **杀整棵进程树**（不能只杀父进程，npx→tsx→node 会留孤儿）：
   `taskkill /PID <pid> /T /F`
3. **换端口复测**：`$env:PORT=3457; npm run web`
   不要反复用同一个端口试，会把旧进程的假象当成新结果。
4. 如果端口仍然被占，按 `CommandLine` 匹配所有 node 进程清理：
   `wmic process where "name='node.exe'" get processid,commandline`

## 为什么会这样

`Start-Process` / `Start-Job` 起的服务在命令结束后会被杀，但
Electron / npx 链可能存活；而 `child.kill()` 只杀 cmd 壳，tsx 孙进程变孤儿。
所以测试脚本里必须 `taskkill /T`，并且每轮测试换端口。
