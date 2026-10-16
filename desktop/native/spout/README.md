# Spout sender

`spout-sender.exe` hands the game's frames to a streaming program on Windows,
on the GPU. The shell runs it (`src/relay.js`) when the game is drawn
offscreen and the settings tab's Spout output is on:

```text
spout-sender.exe <shell-pid> [--name <sender>]
stdin   "<id> <nt-handle> <width> <height>"   a frame Electron lent the shell
stdout  "<id> ok" | "<id> err <what>"          once the copy has run on the GPU
```

It opens each frame's texture by its handle on a Direct3D 11 device of its own,
copies it into one texture it shares under Spout's sender name (`Akagi`), and
answers; the shell then gives the frame back to Chromium. A Spout receiver —
in OBS, the Spout2 plugin's *Spout2 Capture* source — reads that texture
directly. The sender list, the shared memory a receiver reads, the access
mutex and the frame count follow the Spout2 SDK
(<https://github.com/leadedge/Spout2>, BSD-2-Clause).

## Building

The desktop workflow builds it on Windows with MSVC, and `scripts/package.mjs`
puts it in the application's `resources/spout/`. By hand, from a Developer
Command Prompt:

```bat
cl /nologo /O2 /EHsc /MT /W3 spout-sender.cpp /Fe:build\spout-sender.exe
```

Without it the application runs as before, with no Spout output.
