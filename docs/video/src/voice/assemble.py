"""assemble.py - lay the nine narration clips on one track with fixed pauses.

Run from the film directory, after synthesising each clip with Kokoro:

    for i in 1 2 3 4 5 6 7 8 9; do
      npx hyperframes tts src/voice/s$i.txt -v af_heart -o assets/vo/s$i.wav
    done
    python3 src/voice/assemble.py 1.4 0.8 162

Arguments: the pause between clips, the lead-in and the film's length, in seconds.
Writes assets/voiceover.wav and src/voice/vo-timing.json (each clip's start and
length, which the scene times in src/scenes/ follow). The track is normalised to
-16 LUFS with a true peak of -1.5 dBTP.
"""
import json
import subprocess
import sys

gap, lead, total = float(sys.argv[1]), float(sys.argv[2]), float(sys.argv[3])
durs = [
    float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f"assets/vo/s{i}.wav"]).decode())
    for i in range(1, 10)
]
t, starts = lead, []
for d in durs:
    starts.append(round(t, 3))
    t += d + gap
end = starts[-1] + durs[-1]
print("starts", starts, "speech ends", round(end, 2))
assert end < total, "the narration runs past the film's end"
json.dump({"durs": durs, "starts": starts}, open("src/voice/vo-timing.json", "w"), indent=1)
inputs, filt = [], []
for i, s in enumerate(starts):
    ms = int(s * 1000)
    inputs += ["-i", f"assets/vo/s{i + 1}.wav"]
    filt.append(f"[{i}:a]aresample=48000,adelay={ms}|{ms}[a{i}]")
filt.append("".join(f"[a{i}]" for i in range(9)) + f"amix=inputs=9:normalize=0,apad=whole_dur={total},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]")
subprocess.check_call(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", ";".join(filt), "-map", "[out]", "-t", str(total), "-ac", "1", "assets/voiceover.wav"])
