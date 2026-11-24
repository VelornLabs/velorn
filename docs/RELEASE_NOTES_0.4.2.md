# Velorn v0.4.2 — Director fixes: the script, lyrics in your language, add a line

This is a small release with three fixes for making a music video in Director.

## Write the script works for whole songs

On Mac and Windows, **Write the script** could stop after about 20 seconds with
"The Velo service could not complete this response".

The cause: Velo's answer has a length limit, and a script for a whole song is
several times longer than that. The answer was cut off and counted as a failure.

From this version on, Velo writes the script a few shots at a time and Velorn
joins the parts into one script.

- The shot count on the screen keeps growing while it writes.
- If Velo stops part of the way through, the shots it already wrote are kept in
  the box, with a note that the script is not finished.

## Lyrics in the song's own language

Listening to a song always heard English words, so a song in another language
came out wrong.

Velorn now works out which language is sung and hears the words in that
language. There is no setting for it. When it is not sure, it uses English.

Not yet: songs written in other alphabets, such as Russian, Greek, Arabic or
Japanese. The part that times each word only knows the letters a to z.

## Add a line the listening missed

In the Song step, click a lyric line and press **Add line below**. A new line
opens under it, ready to type. Move it with Earlier, Later or Starts at, like
any other line.

## Downloads

- `Windows Installer`: standard Windows install for most users
- `Windows Portable`: no-install Windows build
- `Mac (Apple Silicon)`: for M1, M2, M3 and newer Macs
- `Mac (Intel)`: for older Intel-based Macs
- `Linux AppImage`: portable Linux build
- `Linux deb`: Debian/Ubuntu package

Ignore the auto-generated source-code archives unless you plan to build Velorn
from source.
