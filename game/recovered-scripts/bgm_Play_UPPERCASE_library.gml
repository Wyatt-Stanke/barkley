/*  Plays the given song. If a filename that does not match any loaded song is
    given it is loaded and played as the Quick Play song.
    Is "loop" is true the song will loop until it is stopped.

    bgm_Play( song, loop <optional> )
    
******************************************************************************/

var ret;

if (is_real(argument0))
  ret = external_call(global._bgm_PlayById, argument0, argument1)
else
  ret = external_call(global._bgm_PlayByFname, argument0, argument1);
if (!ret && global._bgm_showErrors)
  show_error(external_call(global._bgm_Error), false);
return ret;