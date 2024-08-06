# Bitburner Companion
A (WIP) companion extension for bitburner.

## Features

### Display RAM usage hints for NS functions directly inline
![image](https://github.com/user-attachments/assets/43a964ab-799e-4119-ba91-3984492216f0)

### Browse and edit ingame files directly from your editor
![image](https://github.com/user-attachments/assets/fc39bffa-c58b-41d3-a538-d5332733df7b)



## Roadmap:
- [x] Browse and edit ingame files from the editor
- [x] Map files in workspace to files on home and display their static RAM usage
  - current implementation is *incredibly* crude and can't deal with more complex layouts.
  - [x] support script-folder-as-home and script-subfolders-as-servers layouts (needs testing!)
- [x] Parse files in workspace for what their RAM usage would look like, and provide usage as `CodeLens`es (needs option to disable)
- [ ] Sync workspace files to game.
  - [x] Support acting as middleman to offload syncing to existing tools like [biburner-filesync](https://github.com/bitburner-official/bitburner-filesync)

## Extension Settings
<!-- TODO: document settings -->

## Known Issues
- Slow, especially RAM usage CodeLenses
- RAM hints don't work for ingame files

## Release Notes

/
