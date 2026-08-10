// Display name helper: Song.name stores the user-provided base name.
// The "(variant task)" suffix is rebuilt dynamically from request fields
// for the card title in the UI and for download filenames.
import type { Song } from './types.js';

export function displaySongName(song: Song): string {
	const m = String(song.request.synth_model || '').match(/^acestep-v15-(.+?)-(Q\d.*|BF16)\.gguf$/);
	const variant = m ? m[1] : '';
	const task = song.request.task_type || '';
	const suffix = [variant, task].filter((s) => s).join(' ');
	return suffix ? song.name + ' (' + suffix + ')' : song.name;
}
