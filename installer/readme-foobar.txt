24seven.fm Covers - foobar2000 component
====================================

Cover art for the Streaming Soundtracks (24seven.fm) stream, shown in a
dockable foobar2000 UI element - and fed to foobar's own Album Art panels
(so the stock Album Art element, playlist art column and taskbar thumbnail
show the cover too).

RECOMMENDED INSTALL (.fb2k-component)
-------------------------------------
In foobar:  Preferences > Components > Install... > pick
foobar_24sevenfm_covers.fb2k-component > Apply, and let foobar restart.
(You can also drag the .fb2k-component onto the components list.)

This works for portable foobar too. Double-clicking the .fb2k-component only
installs it if foobar's own installer registered that file type; on a portable
copy with a hand-made file association, foobar may instead try to PLAY the file
- use the Install... button above instead.

MANUAL INSTALL (this zip)
-------------------------
1. Close foobar2000.
2. Copy  foo_24sevenfm_covers.dll  into your foobar2000 "components" folder, e.g.
      C:\Program Files\foobar2000\components\
   (or the components folder next to foobar2000.exe for a portable install).
3. Start foobar2000. Add the panel: right-click your layout >
   Insert UI Element > Playback visualisation > "24seven.fm Covers"
   (or use it via the standalone popup command).

CONFIGURE
---------
Preferences > Display > 24seven.fm Covers
(remaining-time overlay + size, transition + duration, rolling digits).

Requires foobar2000 v2 (64-bit).
