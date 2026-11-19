# Velorn v0.4.1 — A finished result is always saved

This is a small release with one important fix for the Visuals and Sound tabs.

## The fix

In 0.4.0, a finished video could end with **"It finished, but couldn't be saved"**.
The clip had been made and paid for, but Velorn refused to download it, and
"Try saving again" gave the same answer.

The cause: Velorn only collected results from Comfy's own storage. Comfy
sometimes hands over a result at the model maker's address instead, and Velorn
treated that as unknown.

From this version on, a finished result is saved wherever it is, the same way
ComfyUI does it:

- A result is downloaded from whatever address Comfy gives for it.
- A download that is passed on to another address is followed.
- A file is no longer refused for its size or its format. A video or sound in a
  format Velorn did not know is saved as it came.
- A picture is kept at whatever size comes back, also when it is not the size
  that was asked for.
- If a model sends several pictures where one was asked for, the first is kept.
  Before, none were.

A second problem behind the same message is fixed too: some storage services
send information along with the file that made Velorn's download stop without
a word. The screen then stayed on "Picking up where you left off".

## If this happened to you

Comfy keeps a finished result for 24 hours. Install 0.4.1, open the same
project and go to Visuals. Velorn picks the job up by itself and saves it.
Nothing is sent or charged again.

## Downloads

- `Windows Installer`: standard Windows install for most users
- `Windows Portable`: no-install Windows build
- `Mac (Apple Silicon)`: for M1, M2, M3 and newer Macs
- `Mac (Intel)`: for older Intel-based Macs
- `Linux AppImage`: portable Linux build
- `Linux deb`: Debian/Ubuntu package

Ignore the auto-generated source-code archives unless you plan to build Velorn
from source.
