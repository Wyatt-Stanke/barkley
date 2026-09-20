/*  Returns whether the given song is playing (1), stopped (0), or paused (2).
    If no song is passed it returns the status of the QP song.
    Returns -1 on error.

    bgm_IsPlaying( song <optional> )
    
    Example:
    
    if (bgm_IsPlaying(song1)==2) {
      show_message("The song is paused.");
    }
    
******************************************************************************/

var ret;

if (is_real(argument0))
  ret = external_call(global._bgm_IsPlayingById, argument0)
else
  ret = external_call(global._bgm_IsPlayingByFname, argument0);
if (ret==-1 && global._bgm_showErrors)
  show_error(external_call(global._bgm_Error), false);
return ret;