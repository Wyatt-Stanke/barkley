namt=sound_get_name(argument1);
namt=string_replace(namt,"m","_");
namt=string_lower(namt);
namt=working_directory + "\Music\" + namt + ".mp3";
global.musicstring=namt;
if (argument0='play') {
//saud_Close("sound");
//saud_Load(namt,"sound");
bgm_Play(namt);
} else if (argument0='loop') {
//saud_Close("sound");
//saud_Load(namt,"sound");
bgm_Play(namt,1);
} else if (argument0='stop') {
global.lastmusic=-1;
bgm_Stop();
return(1);
} else if (argument0='stopall') {
global.lastmusic=-1;
sound_stop_all();
bgm_Stop();
return(1);
} else if (argument0='check') {
if (global.lastmusic=argument1) return(1);
else return(0);
}
global.lastmusic=argument1;
