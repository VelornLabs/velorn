# Desktop reply media menu

The reply's small options button, beside Copy, opens **Show project media here**.
The project-media picker is absent until explicitly opened. It is not the
composer paperclip: the paperclip supplies an input for the next model request;
this action adds playback of an existing project asset to a particular reply.

Existing automatic output attachment, saved media references, players, missing-
file placeholders, and phone catalogs are unchanged. This change does not send
a model request, upload media, regenerate a clip, duplicate an import, alter a
timeline, or change sharing permissions. The native IPC/store remains byte-for-
byte unchanged. Only the UI location and the assistant's description of where
to find it have changed.

- The menu is shown only when project-media choices exist.
- Escape, Tab and outside click dismiss the menu. Keyboard users can open it
  with Enter/Space or arrow keys, and activate its item normally.
- Opening the picker focuses its first choice. Cancel/Escape clear temporary
  selection without attaching anything and return focus to the options button.
- Add to reply closes the picker on success. Errors retain selection for an
  explicit retry; pending writes disable repeat submission.
- Existing busy/export/project-loading restrictions are retained.
- Changing chat remounts the reply-media controls so an old selection is not
  carried into another conversation. Opening or closing the picker does not
  remount an existing player.

Tests use disposable synthesized WAV/MP4 files with the actual native IPC/store,
actual React components, and network-blocked browser fixtures. They cover menu
keyboard/outside interactions, cancellation, errors, busy/empty states, correct
turn attachment, playback stability, native-store recreation, reload, chat
isolation, missing files, and narrow layouts. An isolated packaged-app test also
checks the options menu next to Copy, bounds within a narrow sidebar, unchanged
allowance/Stop controls, and restoration after reopening. Its account/provider/
media responses are synthetic; no real inference or account access is involved.
