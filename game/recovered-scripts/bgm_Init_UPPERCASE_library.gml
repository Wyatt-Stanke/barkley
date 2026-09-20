/* Initializes BGM. Must be called once before calling anything else besides
   bgm_SetLibDir() or bgm_SetShowErrors().
   Don't call again until after bgm_Close() is called.

   bgm_Init( device_number,
             output_frequency,
             use_8bit,
             use_mono );

******************************************************************************/

var dll;

// Get full filename of the dll
if (!variable_global_exists("_bgm_path"))
  global._bgm_path = "bgm.dll"
else
  global._bgm_path += "\bgm.dll";
  
dll = global._bgm_path;

// Set the default for displaying errors, if not already set
if (!variable_global_exists("_bgm_showErrors"))
  global._bgm_showErrors = true;

// Function import table ------------------------------------------------------

global._bgm_Init               = external_define(dll, "bgm_Init",                 dll_cdecl, ty_real,   5, ty_real, ty_real, ty_real, ty_real, ty_real);
global._bgm_Close              = external_define(dll, "bgm_Close",                dll_cdecl, ty_real,   0 );
global._bgm_Load               = external_define(dll, "bgm_Load",                 dll_cdecl, ty_real,   3, ty_string, ty_real, ty_real );
global._bgm_LoadMod            = external_define(dll, "bgm_LoadMod",              dll_cdecl, ty_real,   2, ty_string, ty_real );
global._bgm_LoadSample         = external_define(dll, "bgm_LoadSample",           dll_cdecl, ty_real,   2, ty_string, ty_real );
global._bgm_LoadStream         = external_define(dll, "bgm_LoadStream",           dll_cdecl, ty_real,   2, ty_string, ty_real );
global._bgm_LoadNetStream      = external_define(dll, "bgm_LoadNetStream",        dll_cdecl, ty_real,   2, ty_string, ty_real );
global._bgm_UnloadById         = external_define(dll, "bgm_UnloadById",           dll_cdecl, ty_real,   1, ty_real );
global._bgm_UnloadByFname      = external_define(dll, "bgm_UnloadByFname",        dll_cdecl, ty_real,   1, ty_string );
global._bgm_IsLoadedById       = external_define(dll, "bgm_IsLoadedById",         dll_cdecl, ty_real,   1, ty_real );
global._bgm_IsLoadedByFname    = external_define(dll, "bgm_IsLoadedByFname",      dll_cdecl, ty_real,   1, ty_string );
global._bgm_PlayById           = external_define(dll, "bgm_PlayById",             dll_cdecl, ty_real,   2, ty_real, ty_real );
global._bgm_PlayByFname        = external_define(dll, "bgm_PlayByFname",          dll_cdecl, ty_real,   2, ty_string, ty_real );
global._bgm_StopById           = external_define(dll, "bgm_StopById",             dll_cdecl, ty_real,   1, ty_real );
global._bgm_StopByFname        = external_define(dll, "bgm_StopByFname",          dll_cdecl, ty_real,   1, ty_string );
global._bgm_PauseById          = external_define(dll, "bgm_PauseById",            dll_cdecl, ty_real,   1, ty_real );
global._bgm_PauseByFname       = external_define(dll, "bgm_PauseByFname",         dll_cdecl, ty_real,   1, ty_string );
global._bgm_UnpauseById        = external_define(dll, "bgm_UnpauseById",          dll_cdecl, ty_real,   1, ty_real );
global._bgm_UnpauseByFname     = external_define(dll, "bgm_UnpauseByFname",       dll_cdecl, ty_real,   1, ty_string );
global._bgm_IsPlayingById      = external_define(dll, "bgm_IsPlayingById",        dll_cdecl, ty_real,   1, ty_real );
global._bgm_IsPlayingByFname   = external_define(dll, "bgm_IsPlayingByFname",     dll_cdecl, ty_real,   1, ty_string );
global._bgm_GetLenById         = external_define(dll, "bgm_GetLenById",           dll_cdecl, ty_real,   1, ty_real );
global._bgm_GetLenByFname      = external_define(dll, "bgm_GetLenByFname",        dll_cdecl, ty_real,   1, ty_string );
global._bgm_GetPosById         = external_define(dll, "bgm_GetPosById",           dll_cdecl, ty_real,   1, ty_real );
global._bgm_GetPosByFname      = external_define(dll, "bgm_GetPosByFname",        dll_cdecl, ty_real,   1, ty_string );
global._bgm_GetOrderById       = external_define(dll, "bgm_GetOrderById",         dll_cdecl, ty_real,   1, ty_real );
global._bgm_GetOrderByFname    = external_define(dll, "bgm_GetOrderByFname",      dll_cdecl, ty_real,   1, ty_string );
global._bgm_GetRowById         = external_define(dll, "bgm_GetRowById",           dll_cdecl, ty_real,   1, ty_real );
global._bgm_GetRowByFname      = external_define(dll, "bgm_GetRowByFname",        dll_cdecl, ty_real,   1, ty_string );
global._bgm_GetAttrById        = external_define(dll, "bgm_GetAttrById",          dll_cdecl, ty_string, 2, ty_real, ty_string );
global._bgm_GetAttrByFname     = external_define(dll, "bgm_GetAttrByFname",       dll_cdecl, ty_string, 2, ty_string, ty_string );
global._bgm_GetAttrTypeLast    = external_define(dll, "bgm_GetAttrTypeLast",      dll_cdecl, ty_real,   0 );
global._bgm_SetAttrById        = external_define(dll, "bgm_SetAttrById",          dll_cdecl, ty_real,   3, ty_real, ty_string, ty_string );
global._bgm_SetAttrByFname     = external_define(dll, "bgm_SetAttrByFname",       dll_cdecl, ty_real,   3, ty_string, ty_string, ty_string );
global._bgm_Error              = external_define(dll, "bgm_Error",                dll_cdecl, ty_string, 0 );
global._bgm_SetReportErrors    = external_define(dll, "bgm_SetReportErrors",      dll_cdecl, ty_real,   1, ty_real );
global._bgm_FadeVolById        = external_define(dll, "bgm_FadeVolById",          dll_cdecl, ty_real,   3, ty_real, ty_real, ty_real );
global._bgm_FadeVolByFname     = external_define(dll, "bgm_FadeVolByFname",       dll_cdecl, ty_real,   3, ty_string, ty_real, ty_real );
global._bgm_VolIsFadingById    = external_define(dll, "bgm_VolIsFadingById",      dll_cdecl, ty_real,   1, ty_real );
global._bgm_VolIsFadingByFname = external_define(dll, "bgm_VolIsFadingByFname",   dll_cdecl, ty_real,   1, ty_string );


// ----------------------------------------------------------------------------

// Call bgm_Init()
if (!external_call(global._bgm_Init, argument0, argument1, argument2,
    argument3, window_handle()))
{
  // Error occured - At this point BGM.DLL will have already cleared it's own
  // memory. Therefore, the only thing to do is to unload the dll.
  
  // Output the error message
  if (global._bgm_showErrors != 0)
    show_error(external_call(global._bgm_Error),false);
  
  // Free all functions
  external_free(global._bgm_path);
  
  // Failure...
  return false;
}

// Success!
return true;