/*  Pauses the given song. If no song is given the Quick Play song will be
    paused.

    bgm_Pause( song <optional> )
    
******************************************************************************/

var ret;

if (is_real(argument0))
  ret = external_call(global._bgm_PauseById, argument0)
else
  ret = external_call(global._bgm_PauseByFname, argument0);
if (!ret && global._bgm_showErrors)
  show_error(external_call(global._bgm_Error), false);
return ret;