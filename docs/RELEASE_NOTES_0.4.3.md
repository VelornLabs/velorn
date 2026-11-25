# Velorn v0.4.3 — Director fix: two people in one shot

This is a small release with two fixes for making a music video in Director.

## Two people in one shot both keep their look

In a shot with two cast members, one of them could come out as a different
person every time the frame was made.

The cause: a shot only gets the pictures of the people named on its `Artist:`
line, and a script usually named just one person there. The other person was
drawn without a picture to go by.

From this version on:

- If the words of a shot name another cast member, Velorn sends that person's
  picture too. A small note on the shot says so.
- New scripts are asked to name every cast member who is in the shot.

Velorn finds a cast member by the name you gave them in Cast. If the script
calls them something else (the cast says "Tom", the words say "her brother"),
put both names on that shot's line yourself, like `Artist: runa, tom`, and
make the frame again.

A shot still takes at most two people. Shots that only show a place or a
detail get no person picture, as before.

## The Back button in Director is whole again

In a music video, the top of the screen covered half of **Back to create
workflows**. It now shows in full.

## Downloads

- `Windows Installer`: standard Windows install for most users
- `Windows Portable`: no-install Windows build
- `Mac (Apple Silicon)`: for M1, M2, M3 and newer Macs
- `Mac (Intel)`: for older Intel-based Macs
- `Linux AppImage`: portable Linux build
- `Linux deb`: Debian/Ubuntu package

**On Windows:** you may see a blue box that says "Windows protected your PC". That is normal for a new version. The installer is signed (the box shows Jaime Aguirre as publisher), but Windows shows this for any file that not many people have downloaded yet. Click **More info** if you do not see a button, then **Run anyway**.

Ignore the auto-generated source-code archives unless you plan to build Velorn
from source.
